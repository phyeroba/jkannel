import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  ConfigurationDiffLine,
  ConfigurationDiffService,
} from '../configuration/configuration-diff.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface DriftResult {
  /** true = live file matches deployed render; false = differs; null = undetermined. */
  inSync: boolean | null;
  deployedChecksum: string | null;
  liveChecksum: string | null;
  differences: ConfigurationDiffLine[];
  deployedVersion: { id: string; scope: string; versionNumber: number } | null;
  configPath: string;
  note: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Configuration drift detection. The intended state is the rendered content of
 * the currently-deployed configuration_versions row; the actual state is the
 * live engine config file the backend can read on a shared volume at
 * KAMEX_CONFIG_PATH. This service compares the two by sha256 and line diff.
 *
 * Limitations (honest): this reads a single Kamex config path. It compares
 * against the most recently deployed version across scopes, so multi-file /
 * multi-scope Kamex layouts are out of scope. Undetermined states (missing
 * file, no deployed version) return inSync=null with an explanatory note rather
 * than guessing.
 */
@Injectable()
export class ConfigDriftService {
  private readonly configPath = process.env.KAMEX_CONFIG_PATH ?? '/var/lib/jkannel/kamex.conf';

  constructor(
    private readonly database: DatabaseService,
    private readonly diff: ConfigurationDiffService,
  ) {}

  private async deployedVersion(client: PoolClient) {
    const row = (
      await client.query<{
        id: string;
        scope: string;
        version_number: number;
        content: { rendered?: unknown } | null;
      }>(
        `SELECT uuid id, scope, version_number, content
           FROM configuration_versions
          WHERE status='deployed'
          ORDER BY deployed_at DESC NULLS LAST
          LIMIT 1`,
      )
    ).rows[0];
    return row;
  }

  private async readLive(): Promise<string | null> {
    try {
      return await readFile(this.configPath, 'utf8');
    } catch {
      // Missing/unreadable file: treated as an undetermined drift state.
      return null;
    }
  }

  /**
   * Computes drift without persisting. Read-only; safe for the drift dashboard.
   */
  async check(actor: Actor): Promise<DriftResult> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const [deployed, live] = await Promise.all([this.deployedVersion(client), this.readLive()]);
      return this.evaluate(deployed, live);
    });
  }

  private evaluate(
    deployed:
      | {
          id: string;
          scope: string;
          version_number: number;
          content: { rendered?: unknown } | null;
        }
      | undefined,
    live: string | null,
  ): DriftResult {
    const rendered =
      deployed && typeof deployed.content?.rendered === 'string'
        ? (deployed.content.rendered as string)
        : null;
    const deployedVersion = deployed
      ? { id: deployed.id, scope: deployed.scope, versionNumber: deployed.version_number }
      : null;
    const deployedChecksum = rendered !== null ? sha256(rendered) : null;
    const liveChecksum = live !== null ? sha256(live) : null;

    if (rendered === null && live === null)
      return {
        inSync: null,
        deployedChecksum,
        liveChecksum,
        differences: [],
        deployedVersion,
        configPath: this.configPath,
        note:
          'Drift undetermined: no deployed configuration version and no live config file ' +
          `at ${this.configPath}.`,
      };
    if (rendered === null)
      return {
        inSync: null,
        deployedChecksum,
        liveChecksum,
        differences: [],
        deployedVersion,
        configPath: this.configPath,
        note:
          'Drift undetermined: no deployed configuration version with rendered content to ' +
          'compare against. Deploy a version, then re-check.',
      };
    if (live === null)
      return {
        inSync: null,
        deployedChecksum,
        liveChecksum,
        differences: [],
        deployedVersion,
        configPath: this.configPath,
        note:
          `Drift undetermined: no live engine config file readable at ${this.configPath}. ` +
          'Confirm the shared volume is mounted and KAMEX_CONFIG_PATH is correct.',
      };

    const inSync = deployedChecksum === liveChecksum;
    const differences = inSync
      ? []
      : this.diff.compare(rendered, live).filter((line) => line.kind !== 'unchanged');
    return {
      inSync,
      deployedChecksum,
      liveChecksum,
      differences,
      deployedVersion,
      configPath: this.configPath,
      note: inSync
        ? 'Live engine configuration matches the deployed version.'
        : // A maintainer could feed this finding into the alert pipeline here
          // (e.g. open a config-drift alert_instance) — intentionally not done
          // so drift checks never generate alert noise on their own.
          'Configuration drift detected: the live engine config differs from the deployed version.',
    };
  }

  /**
   * Runs a drift check and records a config_drift_checks row for the audit
   * trail. Returns the same DriftResult plus the persisted check id.
   */
  async recordCheck(actor: Actor): Promise<DriftResult & { checkId: string }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const [deployed, live] = await Promise.all([this.deployedVersion(client), this.readLive()]);
      const result = this.evaluate(deployed, live);
      const inserted = (
        await client.query<{ id: string }>(
          `INSERT INTO config_drift_checks
             (tenant_id,in_sync,deployed_checksum,live_checksum,detail,checked_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            actor.tenantId,
            result.inSync,
            result.deployedChecksum,
            result.liveChecksum,
            JSON.stringify({
              configPath: result.configPath,
              note: result.note,
              deployedVersion: result.deployedVersion,
              differenceCount: result.differences.length,
            }),
            actor.userId,
          ],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'config_drift.checked',
          'config_drift_check',
          inserted.id,
          JSON.stringify({ inSync: result.inSync, note: result.note }),
        ],
      );
      return { ...result, checkId: inserted.id };
    });
  }
}
