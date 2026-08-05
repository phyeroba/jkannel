import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { Actor } from './message-send.service';
import {
  CompiledMoRule,
  MAX_DESTINATIONS_PER_RULE,
  MoDeliveryKind,
  MoDestinationMatchType,
  MoDestinationRow,
  MoKeywordMatchType,
  MoMessageContext,
  MoRuleRow,
  compareMoRules,
  compileMoRule,
  matchMoRules,
  parseDeliveryKind,
  parseDestinationMatchType,
  parseKeywordMatchType,
  validateDestinationTarget,
} from './mo-routing';

export interface CreateMoRuleInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  matchSmscId?: string | null;
  matchDestination?: string | null;
  matchDestinationType?: MoDestinationMatchType;
  matchSenderPrefix?: string | null;
  matchKeyword?: string | null;
  matchKeywordType?: MoKeywordMatchType;
  caseSensitive?: boolean;
  continueAfterMatch?: boolean;
  customerId?: string | null;
}

export type UpdateMoRuleInput = Partial<CreateMoRuleInput>;

export interface CreateMoDestinationInput {
  kind: MoDeliveryKind;
  target: string;
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  maxAttempts?: number;
}

const RULE_COLUMNS =
  'id::text,name,description,enabled,priority,match_smsc_id,match_destination,' +
  'match_destination_type,match_sender_prefix,match_keyword,match_keyword_type,case_sensitive,' +
  'continue_after_match,customer_id::text,created_by,created_at,updated_at';

const DESTINATION_COLUMNS =
  'id::text,rule_id::text,kind,target,enabled,config,max_attempts,created_by,created_at,updated_at';

/** Grid whitelist for GET /mo/rules. */
export const MO_RULE_GRID: GridDefinition = {
  searchColumns: ['name', 'description', 'match_keyword', 'match_destination', 'created_by'],
  sortColumns: {
    priority: 'priority',
    name: 'name',
    enabled: 'enabled',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  filterColumns: {
    enabled: 'enabled',
    matchSmscId: 'match_smsc_id',
    matchKeywordType: 'match_keyword_type',
    customerId: 'customer_id',
    createdBy: 'created_by',
  },
  defaultOrderBy: 'priority ASC, created_at ASC, id ASC',
  defaultLimit: 50,
  maxLimit: 500,
};

const ENGINE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Ceiling on enabled MO rules per tenant: ingest cost must stay bounded too. */
export const MAX_MO_RULES_PER_TENANT = 200;

/**
 * MO routing rule administration and matching.
 *
 * The rules themselves are ordinary tenant-scoped rows; what matters here is
 * that {@link loadInClient} produces the SAME sorted, compiled rule set that
 * both the real ingest path and the preview endpoint use, so an operator who
 * previews a rule and then receives the real message cannot get two answers.
 */
@Injectable()
export class MoRulesService {
  constructor(private readonly database: DatabaseService) {}

  // =========================================================================
  // MATCHING
  // =========================================================================

  /**
   * Every enabled rule with its enabled destinations, in evaluation order.
   *
   * Two queries rather than a join with array aggregation: MO ingest is a
   * background sweep, not the send path, so the clarity is worth more than the
   * round trip. This deliberately does NOT cache — unlike content filtering it
   * is not on the latency-critical path, and a stale MO rule means an inbound
   * message is delivered somewhere the operator just stopped wanting it.
   */
  async loadInClient(client: PoolClient): Promise<CompiledMoRule[]> {
    const rules = (
      await client.query<MoRuleRow>(
        `SELECT ${RULE_COLUMNS} FROM mo_routing_rules WHERE enabled = true
          ORDER BY priority ASC, created_at ASC, id ASC LIMIT ${MAX_MO_RULES_PER_TENANT}`,
      )
    ).rows;
    if (!rules.length) return [];
    const destinations = (
      await client.query<MoDestinationRow>(
        `SELECT ${DESTINATION_COLUMNS} FROM mo_rule_destinations
          WHERE enabled = true AND rule_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
        [rules.map((rule) => rule.id)],
      )
    ).rows;
    return rules.map((rule) => compileMoRule(rule, destinations)).sort(compareMoRules);
  }

  /** What would happen to this inbound message? Same matcher the ingest uses. */
  async preview(actor: Actor, context: MoMessageContext) {
    const rules = await this.database.tenantTransaction(actor.tenantId, (client) =>
      this.loadInClient(client),
    );
    const result = matchMoRules(rules, context);
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return {
      ...result,
      rulesLoaded: rules.length,
      deliveries: result.matches.flatMap((match) =>
        (byId.get(match.ruleId)?.destinations ?? []).map((destination) => ({
          ruleId: match.ruleId,
          ruleName: match.ruleName,
          destinationId: destination.id,
          kind: destination.kind,
          target: destination.target,
        })),
      ),
      context,
    };
  }

  // =========================================================================
  // RULE CRUD
  // =========================================================================

  list(actor: Actor, query: Record<string, unknown> = {}): Promise<GridResult<MoRuleRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<MoRuleRow>(
        { select: `SELECT ${RULE_COLUMNS}`, from: 'FROM mo_routing_rules' },
        MO_RULE_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'priority', direction: 'ASC' } },
      ),
    );
  }

  async get(actor: Actor, id: string): Promise<MoRuleRow & { destinations: MoDestinationRow[] }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rule = (
        await client.query<MoRuleRow>(`SELECT ${RULE_COLUMNS} FROM mo_routing_rules WHERE id=$1`, [
          id,
        ])
      ).rows[0];
      if (!rule) throw new NotFoundException('MO routing rule not found');
      const destinations = (
        await client.query<MoDestinationRow>(
          `SELECT ${DESTINATION_COLUMNS} FROM mo_rule_destinations WHERE rule_id=$1 ORDER BY created_at ASC`,
          [id],
        )
      ).rows;
      return { ...rule, destinations };
    });
  }

  async create(actor: Actor, input: CreateMoRuleInput): Promise<MoRuleRow> {
    const prepared = this.prepare(input, undefined);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await this.assertScopeExists(client, prepared.matchSmscId, prepared.customerId);
      if (prepared.enabled) await this.assertCapacity(client, null);
      const row = (
        await uniqueName(prepared.name, () =>
          client.query<MoRuleRow>(
            `INSERT INTO mo_routing_rules
             (tenant_id,name,description,enabled,priority,match_smsc_id,match_destination,
              match_destination_type,match_sender_prefix,match_keyword,match_keyword_type,
              case_sensitive,continue_after_match,customer_id,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING ${RULE_COLUMNS}`,
            [
              actor.tenantId,
              prepared.name,
              prepared.description,
              prepared.enabled,
              prepared.priority,
              prepared.matchSmscId,
              prepared.matchDestination,
              prepared.matchDestinationType,
              prepared.matchSenderPrefix,
              prepared.matchKeyword,
              prepared.matchKeywordType,
              prepared.caseSensitive,
              prepared.continueAfterMatch,
              prepared.customerId,
              actor.userId,
            ],
          ),
        )
      ).rows[0];
      await this.audit(client, actor, 'created', 'mo_routing_rule', row.id, row);
      return row;
    });
  }

  async update(actor: Actor, id: string, input: UpdateMoRuleInput): Promise<MoRuleRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const existing = (
        await client.query<MoRuleRow>(
          `SELECT ${RULE_COLUMNS} FROM mo_routing_rules WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!existing) throw new NotFoundException('MO routing rule not found');
      const prepared = this.prepare(input, existing);
      await this.assertScopeExists(client, prepared.matchSmscId, prepared.customerId);
      if (prepared.enabled && !existing.enabled) await this.assertCapacity(client, id);
      const row = (
        await uniqueName(prepared.name, () =>
          client.query<MoRuleRow>(
            `UPDATE mo_routing_rules
              SET name=$2,description=$3,enabled=$4,priority=$5,match_smsc_id=$6,
                  match_destination=$7,match_destination_type=$8,match_sender_prefix=$9,
                  match_keyword=$10,match_keyword_type=$11,case_sensitive=$12,
                  continue_after_match=$13,customer_id=$14,updated_at=now()
            WHERE id=$1 RETURNING ${RULE_COLUMNS}`,
            [
              id,
              prepared.name,
              prepared.description,
              prepared.enabled,
              prepared.priority,
              prepared.matchSmscId,
              prepared.matchDestination,
              prepared.matchDestinationType,
              prepared.matchSenderPrefix,
              prepared.matchKeyword,
              prepared.matchKeywordType,
              prepared.caseSensitive,
              prepared.continueAfterMatch,
              prepared.customerId,
            ],
          ),
        )
      ).rows[0];
      await this.audit(client, actor, 'updated', 'mo_routing_rule', id, row, existing);
      return row;
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const deleted = (
        await client.query<{ id: string; name: string }>(
          'DELETE FROM mo_routing_rules WHERE id=$1 RETURNING id::text,name',
          [id],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('MO routing rule not found');
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'mo_routing_rule.deleted',
          'mo_routing_rule',
          deleted.id,
          JSON.stringify({ name: deleted.name }),
        ],
      );
    });
  }

  // =========================================================================
  // DESTINATION CRUD
  // =========================================================================

  async addDestination(
    actor: Actor,
    ruleId: string,
    input: CreateMoDestinationInput,
  ): Promise<MoDestinationRow> {
    const kind = parseDeliveryKind(input.kind);
    const target = validateDestinationTarget(kind, input.target);
    const config = validateDestinationConfig(kind, input.config ?? {});
    const maxAttempts = boundedAttempts(input.maxAttempts);
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const rule = (await client.query('SELECT 1 FROM mo_routing_rules WHERE id=$1', [ruleId]))
        .rows[0];
      if (!rule) throw new NotFoundException('MO routing rule not found');
      const count = Number(
        (
          await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM mo_rule_destinations WHERE rule_id=$1',
            [ruleId],
          )
        ).rows[0].count,
      );
      if (count >= MAX_DESTINATIONS_PER_RULE)
        throw new BadRequestException(
          `A rule may fan out to at most ${MAX_DESTINATIONS_PER_RULE} destinations`,
        );
      const row = (
        await client.query<MoDestinationRow>(
          `INSERT INTO mo_rule_destinations
             (tenant_id,rule_id,kind,target,enabled,config,max_attempts,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id,rule_id,kind,target) DO UPDATE SET
             enabled = EXCLUDED.enabled, config = EXCLUDED.config,
             max_attempts = EXCLUDED.max_attempts, updated_at = now()
           RETURNING ${DESTINATION_COLUMNS}`,
          [
            actor.tenantId,
            ruleId,
            kind,
            target,
            input.enabled ?? true,
            JSON.stringify(config),
            maxAttempts,
            actor.userId,
          ],
        )
      ).rows[0];
      await this.audit(client, actor, 'destination_added', 'mo_rule_destination', row.id, row);
      return row;
    });
  }

  async removeDestination(actor: Actor, ruleId: string, destinationId: string): Promise<void> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const deleted = (
        await client.query<{ id: string; kind: string; target: string }>(
          'DELETE FROM mo_rule_destinations WHERE id=$1 AND rule_id=$2 RETURNING id::text,kind,target',
          [destinationId, ruleId],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('MO destination not found');
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'mo_rule_destination.deleted',
          'mo_rule_destination',
          deleted.id,
          JSON.stringify({ kind: deleted.kind, target: deleted.target }),
        ],
      );
    });
  }

  // ---- helpers -------------------------------------------------------------

  private async audit(
    client: PoolClient,
    actor: Actor,
    verb: string,
    entityType: string,
    id: string,
    next: unknown,
    previous?: unknown,
  ): Promise<void> {
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor.tenantId,
        actor.userId,
        `${entityType}.${verb}`,
        entityType,
        id,
        previous ? JSON.stringify(previous) : null,
        JSON.stringify(next),
      ],
    );
  }

  private async assertCapacity(client: PoolClient, excludeId: string | null): Promise<void> {
    const count = Number(
      (
        await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM mo_routing_rules WHERE enabled = true AND ($1::uuid IS NULL OR id <> $1::uuid)',
          [excludeId],
        )
      ).rows[0].count,
    );
    if (count >= MAX_MO_RULES_PER_TENANT)
      throw new BadRequestException(
        `A tenant may have at most ${MAX_MO_RULES_PER_TENANT} enabled MO routing rules`,
      );
  }

  private async assertScopeExists(
    client: PoolClient,
    smscId: string | null,
    customerId: string | null,
  ): Promise<void> {
    if (smscId) {
      const found = (
        await client.query('SELECT 1 FROM smsc_definitions WHERE engine_id=$1', [smscId])
      ).rows[0];
      if (!found)
        throw new BadRequestException(
          `matchSmscId "${smscId}" is not one of your tenant's SMSCs; a rule scoped to it would never match`,
        );
    }
    if (customerId) {
      const found = (await client.query('SELECT 1 FROM customers WHERE id=$1', [customerId]))
        .rows[0];
      if (!found) throw new NotFoundException('Customer not found');
    }
  }

  private prepare(input: UpdateMoRuleInput, existing: MoRuleRow | undefined) {
    const name = input.name !== undefined ? String(input.name).trim() : (existing?.name ?? '');
    if (!name) throw new BadRequestException('name is required');
    if (name.length > 200) throw new BadRequestException('name must be at most 200 characters');

    const priorityRaw = input.priority ?? (existing ? existing.priority : undefined);
    let priority = 100;
    if (priorityRaw !== undefined && priorityRaw !== null && priorityRaw !== ('' as never)) {
      priority = Number(priorityRaw);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000)
        throw new BadRequestException('priority must be an integer between 0 and 1000000');
    }

    const matchDestinationType = parseDestinationMatchType(
      input.matchDestinationType ?? existing?.match_destination_type,
    );
    const matchKeywordType = parseKeywordMatchType(
      input.matchKeywordType ?? existing?.match_keyword_type,
    );
    const matchDestination = optionalScalar(
      input.matchDestination === undefined ? existing?.match_destination : input.matchDestination,
      'matchDestination',
      64,
    );
    const matchKeyword = optionalScalar(
      input.matchKeyword === undefined ? existing?.match_keyword : input.matchKeyword,
      'matchKeyword',
      160,
    );

    // A criterion with a type but no value (or a value with no type) would
    // silently mean "any", which is not what the operator wrote down.
    if (matchDestinationType !== 'any' && !matchDestination)
      throw new BadRequestException(
        'matchDestination is required when matchDestinationType is not "any"',
      );
    if (matchKeywordType !== 'any' && !matchKeyword)
      throw new BadRequestException('matchKeyword is required when matchKeywordType is not "any"');

    const matchSmscId = optionalScalar(
      input.matchSmscId === undefined ? existing?.match_smsc_id : input.matchSmscId,
      'matchSmscId',
      64,
    );
    if (matchSmscId && !ENGINE_ID.test(matchSmscId))
      throw new BadRequestException('matchSmscId must be an engine-level SMSC identifier');

    const customerId = optionalScalar(
      input.customerId === undefined ? existing?.customer_id : input.customerId,
      'customerId',
      64,
    );
    if (customerId && !UUID.test(customerId))
      throw new BadRequestException('customerId must be a UUID');

    const matchSenderPrefix = optionalScalar(
      input.matchSenderPrefix === undefined
        ? existing?.match_sender_prefix
        : input.matchSenderPrefix,
      'matchSenderPrefix',
      20,
    );
    if (matchSenderPrefix && !/^[0-9+ ()-]+$/.test(matchSenderPrefix))
      throw new BadRequestException('matchSenderPrefix must be a numeric MSISDN prefix');

    return {
      name,
      description:
        input.description === undefined
          ? (existing?.description ?? null)
          : (optionalScalar(input.description, 'description', 2000) ?? null),
      enabled: input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled),
      priority,
      matchSmscId,
      matchDestination,
      matchDestinationType,
      matchSenderPrefix,
      matchKeyword,
      matchKeywordType,
      caseSensitive:
        input.caseSensitive === undefined
          ? (existing?.case_sensitive ?? false)
          : Boolean(input.caseSensitive),
      continueAfterMatch:
        input.continueAfterMatch === undefined
          ? (existing?.continue_after_match ?? false)
          : Boolean(input.continueAfterMatch),
      customerId,
    };
  }
}

/**
 * Turns the `(tenant_id, name)` unique violation into a 409. A duplicate name is
 * an operator mistake, and an operator mistake is never a 500.
 */
async function uniqueName<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ConflictException(`An MO routing rule named "${name}" already exists`);
    throw error;
  }
}

function optionalScalar(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`);
  return text;
}

function boundedAttempts(value: unknown): number {
  if (value === undefined || value === null || value === '') return 5;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20)
    throw new BadRequestException('maxAttempts must be an integer between 1 and 20');
  return parsed;
}

/**
 * Per-kind destination configuration. Unknown keys are DROPPED rather than
 * stored: a config key that looks meaningful and does nothing is how an
 * operator ends up believing a header is being sent when it is not.
 */
export function validateDestinationConfig(
  kind: MoDeliveryKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const source = config && typeof config === 'object' ? config : {};
  if (kind === 'webhook') {
    const out: Record<string, unknown> = {};
    const method = String(source.method ?? 'POST').toUpperCase();
    if (method !== 'POST' && method !== 'PUT')
      throw new BadRequestException('config.method must be POST or PUT');
    out.method = method;
    if (source.secret !== undefined && source.secret !== null) {
      if (typeof source.secret !== 'string' || source.secret.length > 512)
        throw new BadRequestException('config.secret must be a string of at most 512 characters');
      out.secret = source.secret;
    }
    if (source.headers !== undefined && source.headers !== null) {
      if (typeof source.headers !== 'object' || Array.isArray(source.headers))
        throw new BadRequestException('config.headers must be an object of string values');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(source.headers as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(key))
          throw new BadRequestException(`config.headers key "${key}" is not a valid header name`);
        // Host/authorization-style overrides of the transport itself are refused;
        // a forwarding rule must not be able to rewrite where the request goes.
        if (/^(host|content-length)$/i.test(key))
          throw new BadRequestException(`config.headers may not set "${key}"`);
        headers[key] = String(value).slice(0, 1024);
      }
      out.headers = headers;
    }
    return out;
  }
  if (kind === 'email') {
    const out: Record<string, unknown> = {};
    if (source.subject !== undefined && source.subject !== null) {
      if (typeof source.subject !== 'string' || source.subject.length > 200)
        throw new BadRequestException('config.subject must be a string of at most 200 characters');
      out.subject = source.subject;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  if (source.sender !== undefined && source.sender !== null) {
    if (typeof source.sender !== 'string' || !source.sender.trim() || source.sender.length > 20)
      throw new BadRequestException('config.sender must be a sender ID of at most 20 characters');
    out.sender = source.sender.trim();
  }
  if (source.smscId !== undefined && source.smscId !== null) {
    if (typeof source.smscId !== 'string' || !ENGINE_ID.test(source.smscId))
      throw new BadRequestException('config.smscId must be an engine-level SMSC identifier');
    out.smscId = source.smscId;
  }
  if (source.customerId !== undefined && source.customerId !== null) {
    if (typeof source.customerId !== 'string' || !UUID.test(source.customerId))
      throw new BadRequestException('config.customerId must be a UUID');
    out.customerId = source.customerId;
  }
  return out;
}
