import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineAdapterRegistry } from '../engine/engine-adapter.registry';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

export interface CopilotActor {
  tenantId: string;
  userId: string;
  permissions: string[];
}

export interface CopilotToolResult {
  tool: string;
  ok: boolean;
  /** Aggregated, privacy-safe data only — never raw message text or MSISDNs. */
  data: unknown;
  note?: string;
}

interface ToolDefinition {
  name: string;
  permission: string;
  description: string;
  run: (actor: CopilotActor) => Promise<unknown>;
}

/**
 * Read-only, RBAC-scoped tools the Ops Copilot may call. Every tool runs inside
 * the caller's tenant transaction and requires a specific permission the caller
 * must hold; tools return aggregates only (counts, statuses, health), never raw
 * message bodies or recipient numbers, so no unredacted PII reaches the model.
 */
@Injectable()
export class CopilotToolsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly engines: EngineAdapterRegistry,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  private tools(): ToolDefinition[] {
    return [
      {
        name: 'traffic_volume',
        permission: 'reports.view',
        description: 'Recent daily message and delivery-report volumes, total and per SMSC/route.',
        run: (actor) =>
          this.database.tenantTransaction(actor.tenantId, async (c) => {
            const rows = await c.query(
              `SELECT period_type, period_start, scope, scope_label, message_count, dlr_count
                 FROM report_snapshots
                WHERE period_start >= (current_date - interval '14 days')
                ORDER BY period_start DESC, scope, scope_label
                LIMIT 60`,
            );
            return { snapshots: rows.rows };
          }),
      },
      {
        name: 'queue_depth',
        permission: 'messages.view',
        description: 'Current outbound queue depth for the tenant’s SMSCs.',
        run: async (actor) => {
          const allowed = await this.database.tenantTransaction(actor.tenantId, async (c) =>
            (
              await c.query<{ engine_id: string }>('SELECT engine_id FROM smsc_definitions')
            ).rows.map((r) => r.engine_id),
          );
          const probe = await this.sqlbox.probe();
          if (!probe.available) return { available: false, reason: probe.evidence };
          return { available: true, ...(await this.sqlbox.queueSummary(allowed)) };
        },
      },
      {
        name: 'smsc_health',
        permission: 'smsc.view',
        description: 'SMSC definitions with lifecycle state and last error.',
        run: (actor) =>
          this.database.tenantTransaction(actor.tenantId, async (c) => {
            const rows = await c.query(
              `SELECT engine_id, name, type, enabled, lifecycle_state, last_error
                 FROM smsc_definitions ORDER BY priority, name LIMIT 50`,
            );
            return { smscs: rows.rows };
          }),
      },
      {
        name: 'open_alerts',
        permission: 'alerts.view',
        description: 'Currently open or acknowledged alerts with severity and source.',
        run: (actor) =>
          this.database.tenantTransaction(actor.tenantId, async (c) => {
            const rows = await c.query(
              `SELECT severity, source, status, summary, opened_at
                 FROM alert_instances WHERE status <> 'resolved'
                ORDER BY opened_at DESC LIMIT 25`,
            );
            return { alerts: rows.rows };
          }),
      },
      {
        name: 'engine_capabilities',
        permission: 'monitoring.view',
        description: 'Engine identity, transport health and discovered capabilities.',
        run: async () => {
          const adapter = this.engines.forImplementation(
            process.env.ENGINE_IMPLEMENTATION ?? 'kamex',
          );
          const [identity, health] = await Promise.all([adapter.identify(), adapter.health()]);
          return { identity, health };
        },
      },
      {
        name: 'recent_audit',
        permission: 'system.view',
        description: 'Recent audit events (who did what, when) — actions and entities only.',
        run: (actor) =>
          this.database.tenantTransaction(actor.tenantId, async (c) => {
            const rows = await c.query(
              `SELECT created_at, actor_id, action, entity_type, entity_id
                 FROM audit_log ORDER BY created_at DESC LIMIT 25`,
            );
            return { events: rows.rows };
          }),
      },
    ];
  }

  /** Tools the caller is permitted to use, for advertising to the model/UI. */
  available(actor: CopilotActor): Array<{ name: string; description: string }> {
    return this.tools()
      .filter((tool) => actor.permissions.includes(tool.permission))
      .map((tool) => ({ name: tool.name, description: tool.description }));
  }

  /**
   * Runs the named tools the caller is permitted to use. Unknown tools and
   * tools the caller lacks permission for are reported honestly, never silently
   * skipped, so the model cannot infer data the user may not see.
   */
  async run(actor: CopilotActor, toolNames: string[]): Promise<CopilotToolResult[]> {
    const defs = this.tools();
    const results: CopilotToolResult[] = [];
    for (const name of toolNames) {
      const def = defs.find((t) => t.name === name);
      if (!def) {
        results.push({ tool: name, ok: false, data: null, note: 'unknown tool' });
        continue;
      }
      if (!actor.permissions.includes(def.permission)) {
        results.push({
          tool: name,
          ok: false,
          data: null,
          note: `caller lacks '${def.permission}' permission`,
        });
        continue;
      }
      try {
        results.push({ tool: name, ok: true, data: await def.run(actor) });
      } catch (error) {
        results.push({ tool: name, ok: false, data: null, note: (error as Error).message });
      }
    }
    return results;
  }
}
