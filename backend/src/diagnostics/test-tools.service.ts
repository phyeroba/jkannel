import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { normalizeMsisdn } from '../routing-depth/msisdn';
import { describeSegments } from '../engine/message-segments';

export interface Actor {
  tenantId: string;
  userId: string;
}

/**
 * Diagnostic test tools (spec §15).
 *
 * Two of the five already existed server-side and are NOT re-implemented here:
 * the SMPP connectivity test (`SmppBindProber`, a real bind handshake) and the
 * encoding/segment analyzer (`engine/message-segments.ts`). This adds the
 * number/prefix lookup, the DLR lookup and the tagging that makes a test send
 * distinguishable.
 */
@Injectable()
export class TestToolsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Normalise a number and say what can and cannot be determined from it.
   *
   * §15 asks this tool to "normalize number and identify configured market /
   * network / prefix". We can do the first and the third. We cannot do the
   * second: there is no prefix-to-operator database in this product, and
   * guessing a network from a prefix would be a fabricated fact an operator
   * would then act on. The response says so rather than leaving a blank field
   * that reads as "no network".
   */
  async lookupNumber(actor: Actor, input: string) {
    const normalized = normalizeMsisdn(input);
    const digits = normalized.digits ?? input.replace(/[^0-9]/g, '');
    if (!digits) throw new BadRequestException('Enter a number to look up');

    const routes = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      // Which configured prefixes match, longest first — the same ordering the
      // selector uses, so this answers "which rule would win" honestly.
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT r.id::text, r.name, r.match_prefix, r.priority, r.enabled, r.deployment_state,
                s.engine_id AS target_engine_id
           FROM routing_rules r
           LEFT JOIN smsc_definitions s ON s.id = r.target_smsc_id
          WHERE r.match_prefix IS NOT NULL AND $1 LIKE r.match_prefix || '%'
          ORDER BY length(r.match_prefix) DESC, r.priority`,
        [digits],
      );
      return rows;
    });

    return {
      input,
      normalized: normalized.e164,
      digits,
      valid: normalized.valid,
      problem: normalized.problem,
      matchingPrefixes: routes,
      limits: [
        // Stated as data so the console cannot quietly omit it.
        'JKANNEL has no prefix-to-operator database, so the mobile network behind this number ' +
          'is not identified. Only prefixes you have configured on routes are matched.',
        normalized.valid
          ? null
          : 'This number could not be normalised to international form. A national number needs ' +
            'DEFAULT_COUNTRY_CODE configured; without it JKANNEL will not guess a country.',
      ].filter(Boolean) as string[],
    };
  }

  /** Encoding and segmentation for a body, before it is sent. */
  analyseMessage(text: string, coding?: number | null) {
    if (typeof text !== 'string') throw new BadRequestException('text is required');
    // Coding left undeclared by default so the analyzer infers GSM-7 vs UCS-2
    // from the content — which is the question an operator is actually asking.
    return describeSegments({ text, coding: coding ?? null });
  }

  /**
   * Marks a message as an operator test.
   *
   * UC-TST-01 asks that test traffic be visually distinguishable in traces and
   * events. Recorded in JKANNEL's own table keyed on `foreign_id` rather than
   * as a column on `sent_sms`, which is engine-owned — adding columns there is
   * something to avoid unless the engine itself reads them.
   */
  async tagTestSend(
    actor: Actor,
    input: { foreignId: string; smscId?: string | null; destination: string; reason?: string },
  ) {
    if (!input.foreignId) throw new BadRequestException('foreignId is required');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO test_sends(tenant_id, foreign_id, smsc_id, destination, reason, sent_by)
         VALUES($1,$2,$3::uuid,$4,$5,$6)
         ON CONFLICT (tenant_id, foreign_id) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING id::text`,
        [
          actor.tenantId,
          input.foreignId,
          input.smscId ?? null,
          input.destination,
          input.reason ?? null,
          actor.userId,
        ],
      );
      return { id: rows[0].id, foreignId: input.foreignId, tagged: true };
    });
  }

  /** Which of these message references were operator tests. */
  async testSendFlags(actor: Actor, foreignIds: string[]): Promise<Set<string>> {
    if (!foreignIds.length) return new Set();
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<{ foreign_id: string }>(
        'SELECT foreign_id FROM test_sends WHERE foreign_id = ANY($1)',
        [foreignIds],
      );
      return new Set(rows.map((row) => row.foreign_id));
    });
  }

  async listTestSends(actor: Actor, limit = 50) {
    const size = Math.min(Math.max(limit, 1), 200);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT t.id::text, t.foreign_id, t.destination, t.reason, t.sent_by, t.created_at,
                s.engine_id
           FROM test_sends t
           LEFT JOIN smsc_definitions s ON s.id = t.smsc_id
          ORDER BY t.created_at DESC LIMIT $1`,
        [size],
      );
      return { items: rows, limit: size };
    });
  }
}
