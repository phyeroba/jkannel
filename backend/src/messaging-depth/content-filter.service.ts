import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { GridDefinition } from '../platform/list-query';
import { GridResult, runGrid } from '../platform/grid-runner';
import { normalizeMsisdn } from '../routing-depth/msisdn';
import {
  CompiledContentRule,
  ContentFilterContext,
  ContentFilterVerdict,
  ContentMatchField,
  ContentMatchType,
  ContentRuleAction,
  ContentRuleRow,
  MAX_REGEX_RULES_PER_TENANT,
  MAX_RULES_PER_TENANT,
  compareRules,
  compileRule,
  evaluateContent,
  explainContent,
  parseAction,
  parseMatchField,
  parseMatchType,
  parsePriority,
  validatePattern,
} from './content-filter';
import { Actor } from './message-send.service';

export interface CreateContentRuleInput {
  name: string;
  description?: string | null;
  matchField: ContentMatchField;
  matchType: ContentMatchType;
  pattern: string;
  caseSensitive?: boolean;
  action: ContentRuleAction;
  smscId?: string | null;
  customerId?: string | null;
  enabled?: boolean;
  priority?: number;
  expiresAt?: Date | null;
  reason?: string | null;
}

export type UpdateContentRuleInput = Partial<CreateContentRuleInput>;

/** A tenant's rule set, sorted once and reused for every send in the window. */
export interface CompiledRuleSet {
  rules: CompiledContentRule[];
  /**
   * True when at least one enabled rule is scoped to a specific SMSC. This is
   * what decides WHERE on the send path the filter runs — see the class doc.
   */
  hasSmscScopedRules: boolean;
  loadedAtMs: number;
}

const COLUMNS =
  'id::text,name,description,match_field,match_type,pattern,case_sensitive,action,smsc_id,' +
  'customer_id::text,enabled,priority,expires_at,reason,match_count,last_matched_at,' +
  'quarantined_at,quarantine_reason,created_by,created_at,updated_at';

/** Grid whitelist for GET /messaging/content-rules. */
export const CONTENT_RULE_GRID: GridDefinition = {
  searchColumns: ['name', 'description', 'pattern', 'reason', 'created_by'],
  sortColumns: {
    priority: 'priority',
    name: 'name',
    action: 'action',
    matchField: 'match_field',
    matchType: 'match_type',
    enabled: 'enabled',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    lastMatchedAt: 'last_matched_at',
    matchCount: 'match_count',
  },
  filterColumns: {
    action: 'action',
    matchField: 'match_field',
    matchType: 'match_type',
    enabled: 'enabled',
    smscId: 'smsc_id',
    customerId: 'customer_id',
    createdBy: 'created_by',
  },
  // The evaluation order IS the useful order: the grid shows the rules in the
  // sequence the send path will consult them.
  defaultOrderBy: 'priority ASC, created_at ASC, id ASC',
  defaultLimit: 50,
  maxLimit: 500,
};

/** Cache window. Short enough that a rule change takes effect quickly. */
function cacheTtlMs(): number {
  const parsed = Number(process.env.CONTENT_FILTER_CACHE_TTL_MS ?? 15_000);
  if (!Number.isFinite(parsed) || parsed < 0) return 15_000;
  return Math.min(Math.floor(parsed), 600_000);
}

/** Bound on cached tenants, so a many-tenant deployment cannot grow unbounded. */
const MAX_CACHED_TENANTS = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGINE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * CONTENT FILTERING ON THE SEND PATH.
 *
 * The recipient blocklist (message-blocklist.service.ts) answers "may I send to
 * this NUMBER". This answers "may I send THIS MESSAGE, from THIS sender, to this
 * number, over THIS carrier" — the operator's actual question, which a
 * number-only list cannot express. It extends that engine rather than starting a
 * second one: same tenant transaction, same "a refusal is a ForbiddenException
 * and never a 500" rule, same "the refusal is recorded" rule.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT RUNS, AND THE ONE HONEST COMPLICATION
 * ---------------------------------------------------------------------------
 * Content filtering belongs BEFORE route selection, next to the blocklist: work
 * a message will never do should not be paid for. But a rule may be scoped to
 * one SMSC ("no promotional keywords over the MTN bind"), and before route
 * selection the SMSC is not yet known. Evaluating such a rule early would mean
 * guessing, and with FIRST-MATCH-WINS precedence a guess is not a small error:
 * an SMSC-scoped `allow` at priority 10 must be able to pre-empt an unscoped
 * `block` at priority 20, and it cannot do that if it was skipped.
 *
 * So the evaluation point is chosen from the DATA, not hard-coded:
 *
 *   - No enabled rule is SMSC-scoped (the overwhelmingly common case): the
 *     carrier is irrelevant to the outcome, so the filter runs BEFORE route
 *     selection, exactly where the spec puts it, and a blocked message costs
 *     nothing more than a rule scan.
 *
 *   - At least one enabled rule IS SMSC-scoped: evaluation is deferred to the
 *     instant AFTER the bind is chosen and BEFORE entitlements are consumed and
 *     before anything is spooled. Route selection is a pure read; nothing has
 *     been charged, reserved or submitted at that point, so deferring costs a
 *     little wasted CPU on a blocked message and buys a correct answer.
 *
 * Either way there is exactly ONE evaluation, exactly one deciding rule, and it
 * happens before the message can leave. `evaluationPoint` on the verdict records
 * which of the two it was, so the choice is observable rather than folklore.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 * Per send, on a cache hit: ZERO extra database round trips and one pass over
 * the tenant's enabled rules — O(rules) linear string operations over an
 * SMS-sized subject. A tenant is capped at {@link MAX_RULES_PER_TENANT} enabled
 * rules and {@link MAX_REGEX_RULES_PER_TENANT} enabled regex rules at write
 * time, so the ceiling is fixed rather than at the mercy of the admin. The
 * measured cost of a full 500-rule scan is asserted by
 * content-filter.service.spec.ts.
 *
 * On a cache MISS (once per tenant per {@link cacheTtlMs}, default 15s) it is
 * one indexed SELECT inside the transaction the send already opened. A rule
 * mutation invalidates this process's cache immediately; other processes see
 * the change within the TTL, which is the deliberate trade for not putting a
 * pub/sub dependency on the send path. `GET /messaging/content-rules/policy`
 * reports the window so an operator knows how long "immediately" is.
 *
 * ---------------------------------------------------------------------------
 * QUARANTINE
 * ---------------------------------------------------------------------------
 * If a regex rule blows its execution budget (content-rule-regex.ts, layer 3),
 * {@link quarantine} disables it in the database, audits it and evicts the
 * cache, so it is executed at most once more anywhere. That is a bypass of one
 * rule for at most one message, which is stated plainly rather than hidden: a
 * filter that can hang the sender is a worse failure than a filter that misses
 * one message and then makes a lot of noise about it.
 */
@Injectable()
export class ContentFilterService {
  private readonly cache = new Map<string, CompiledRuleSet>();

  constructor(private readonly database: DatabaseService) {}

  // =========================================================================
  // SEND PATH
  // =========================================================================

  /** Drops a tenant's cached rule set (after any mutation, or a quarantine). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  /** Test/diagnostic hook: empties the whole cache. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * The tenant's enabled, unexpired rules, compiled and sorted into evaluation
   * order. Cached for {@link cacheTtlMs}.
   */
  async loadInClient(client: PoolClient, tenantId: string): Promise<CompiledRuleSet> {
    const cached = this.cache.get(tenantId);
    const ttl = cacheTtlMs();
    if (cached && Date.now() - cached.loadedAtMs < ttl) return cached;

    const rows = (
      await client.query<ContentRuleRow>(
        `SELECT ${COLUMNS} FROM messaging_content_rules
          WHERE enabled = true
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY priority ASC, created_at ASC, id ASC
          LIMIT ${MAX_RULES_PER_TENANT}`,
      )
    ).rows;

    const rules = rows.map(compileRule).sort(compareRules);
    const set: CompiledRuleSet = {
      rules,
      hasSmscScopedRules: rules.some((rule) => rule.smscId !== null),
      loadedAtMs: Date.now(),
    };
    // Bounded cache: evict the oldest entry rather than grow without limit.
    if (!this.cache.has(tenantId) && this.cache.size >= MAX_CACHED_TENANTS) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(tenantId, set);
    return set;
  }

  /** Pure evaluation against an already-loaded rule set. No I/O. */
  evaluate(set: CompiledRuleSet, context: ContentFilterContext): ContentFilterVerdict {
    return evaluateContent(set.rules, context);
  }

  /**
   * Refuses a blocked message with a {@link ForbiddenException} naming the rule.
   * A refusal is a policy decision, so it is a 403 and never a 500, and the
   * message it carries is the same sentence recorded on the decision row.
   */
  assertAllowed(verdict: ContentFilterVerdict): void {
    if (!verdict.allowed) throw new ForbiddenException(`Refused by ${verdict.reason}`);
  }

  /**
   * Post-evaluation bookkeeping, deliberately OUTSIDE the send transaction and
   * never awaited by the caller's happy path: quarantine any rule that blew its
   * budget, and bump the hit counter of a rule that blocked. Neither may change
   * the outcome the caller saw, and neither may fail a send.
   */
  async settle(tenantId: string, verdict: ContentFilterVerdict): Promise<void> {
    try {
      if (verdict.overBudgetRuleIds.length)
        await this.quarantine(tenantId, verdict.overBudgetRuleIds);
      const decided = verdict.decidedBy;
      // Only BLOCKS are counted. Counting allows (and non-matches) would put a
      // write on every successful send for no operational benefit; blocks are
      // rare and "is this rule doing anything?" is a real question about them.
      if (decided && decided.action === 'block') await this.recordHit(tenantId, decided.ruleId);
    } catch (error) {
      this.warn('content filter bookkeeping failed', tenantId, error);
    }
  }

  private async recordHit(tenantId: string, ruleId: string): Promise<void> {
    await this.database.tenantTransaction(tenantId, (client) =>
      client.query(
        'UPDATE messaging_content_rules SET match_count = match_count + 1, last_matched_at = now() WHERE id = $1',
        [ruleId],
      ),
    );
  }

  /**
   * Disables rules whose regex exceeded the execution budget. Loud: an error log
   * and an audit row, because a silently disabled filter is how traffic starts
   * going out that an operator believes is being blocked.
   */
  async quarantine(tenantId: string, ruleIds: string[]): Promise<void> {
    const reason =
      'Regex execution exceeded the send-path budget. The rule was disabled automatically to ' +
      'protect the sender; review the pattern and re-enable it.';
    await this.database.tenantTransaction(tenantId, async (client) => {
      const disabled = (
        await client.query<{ id: string; name: string; pattern: string }>(
          `UPDATE messaging_content_rules
              SET enabled = false, quarantined_at = now(), quarantine_reason = $2, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND enabled = true
            RETURNING id::text, name, pattern`,
          [ruleIds, reason],
        )
      ).rows;
      for (const rule of disabled) {
        this.warn(
          `content rule ${rule.name} quarantined: regex over budget`,
          tenantId,
          rule.pattern,
        );
        await client.query(
          'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            tenantId,
            'system',
            'messaging_content_rule.quarantined',
            'messaging_content_rule',
            rule.id,
            JSON.stringify({ pattern: rule.pattern, enabled: false }),
            reason,
          ],
        );
      }
    });
    this.invalidate(tenantId);
  }

  private warn(message: string, tenantId: string, detail: unknown): void {
    console.error(
      JSON.stringify({
        level: 'error',
        message,
        tenantId,
        detail: detail instanceof Error ? detail.message : String(detail),
      }),
    );
  }

  // =========================================================================
  // OPERATOR API
  // =========================================================================

  list(actor: Actor, query: Record<string, unknown> = {}): Promise<GridResult<ContentRuleRow>> {
    return this.database.tenantTransaction(actor.tenantId, (client) =>
      runGrid<ContentRuleRow>(
        { select: `SELECT ${COLUMNS}`, from: 'FROM messaging_content_rules' },
        CONTENT_RULE_GRID,
        query,
        (sql, params) => client.query(sql, params).then((result) => result.rows),
        { idExpr: 'id', cursorDefaultSort: { field: 'priority', direction: 'ASC' } },
      ),
    );
  }

  async get(actor: Actor, id: string): Promise<ContentRuleRow> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query<ContentRuleRow>(
          `SELECT ${COLUMNS} FROM messaging_content_rules WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Content rule not found');
      return row;
    });
  }

  /**
   * Preview: what would happen to this candidate message, and which rules are
   * involved. Runs the SAME evaluation the send path runs, over the SAME cached
   * rule set, so a preview that says "allowed" and a send that is blocked cannot
   * disagree. It reports EVERY matching rule, marking the ones a
   * higher-precedence rule shadows, because "my rule does nothing" and "my rule
   * is shadowed by rule X" are different problems with the same symptom.
   *
   * `smscId` is optional. Omitted, SMSC-scoped rules are reported as
   * out-of-scope, which is exactly what the send path does when the carrier is
   * not yet known — the preview does not pretend to more certainty than the
   * caller supplied.
   */
  async preview(
    actor: Actor,
    input: {
      sender?: string;
      recipient?: string;
      text?: string;
      smscId?: string | null;
      customerId?: string | null;
    },
  ) {
    const recipientRaw = typeof input.recipient === 'string' ? input.recipient : '';
    // Normalise exactly as the send path does, so a `recipient` rule previews
    // against the same canonical digits it will be evaluated against for real.
    const normalized = normalizeMsisdn(recipientRaw);
    const context: ContentFilterContext = {
      sender: typeof input.sender === 'string' ? input.sender : '',
      recipient: normalized.digits ?? recipientRaw.replace(/[^0-9]/g, ''),
      body: typeof input.text === 'string' ? input.text : '',
      smscId: input.smscId ?? null,
      customerId: input.customerId ?? null,
    };

    const set = await this.database.tenantTransaction(actor.tenantId, (client) =>
      this.loadInClient(client, actor.tenantId),
    );
    const explained = explainContent(set.rules, context);
    // A preview must not leave a hazardous rule armed either.
    if (explained.verdict.overBudgetRuleIds.length)
      await this.quarantine(actor.tenantId, explained.verdict.overBudgetRuleIds).catch(
        () => undefined,
      );

    return {
      allowed: explained.verdict.allowed,
      outcome: explained.verdict.allowed ? ('allow' as const) : ('block' as const),
      reason: explained.verdict.reason,
      decidedBy: explained.verdict.decidedBy,
      matches: explained.matches,
      rulesInScope: explained.inScope,
      rulesOutOfScope: explained.skippedOutOfScope,
      rulesLoaded: set.rules.length,
      evaluationPoint: set.hasSmscScopedRules ? 'after_route_selection' : 'before_route_selection',
      context: { ...context, recipientRaw },
      quarantined: explained.verdict.overBudgetRuleIds,
    };
  }

  /** The policy this deployment applies, so a console need not hard-code it. */
  policy() {
    return {
      precedence: 'first_match_wins',
      order: 'priority ASC, created_at ASC, id ASC',
      defaultOutcome: 'allow',
      explanation:
        'Rules are evaluated in priority order (lowest number first); the first rule that ' +
        'matches decides and no later rule is consulted. Put an allow rule at a LOWER priority ' +
        'number than the block it is meant to exempt. With no matching rule the message is sent.',
      matchFields: ['body', 'sender', 'recipient', 'any'],
      matchTypes: ['substring', 'exact', 'prefix', 'regex'],
      maxRules: MAX_RULES_PER_TENANT,
      maxRegexRules: MAX_REGEX_RULES_PER_TENANT,
      cacheTtlMs: cacheTtlMs(),
      cacheNote:
        'A rule change takes effect immediately in the process that made it and within ' +
        'cacheTtlMs in every other process.',
    };
  }

  async create(actor: Actor, input: CreateContentRuleInput): Promise<ContentRuleRow> {
    const prepared = this.prepare(input, undefined);
    const row = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await this.assertScopeExists(client, prepared.smscId, prepared.customerId);
      if (prepared.enabled) await this.assertCapacity(client, prepared.matchType, null);
      const inserted = (
        await runUnique(prepared.name, () =>
          client.query<ContentRuleRow>(
            `INSERT INTO messaging_content_rules
             (tenant_id,name,description,match_field,match_type,pattern,case_sensitive,action,
              smsc_id,customer_id,enabled,priority,expires_at,reason,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING ${COLUMNS}`,
            [
              actor.tenantId,
              prepared.name,
              prepared.description,
              prepared.matchField,
              prepared.matchType,
              prepared.pattern,
              prepared.caseSensitive,
              prepared.action,
              prepared.smscId,
              prepared.customerId,
              prepared.enabled,
              prepared.priority,
              prepared.expiresAt,
              prepared.reason,
              actor.userId,
            ],
          ),
        )
      ).rows[0];
      await this.audit(client, actor, 'created', inserted.id, inserted);
      return inserted;
    });
    this.invalidate(actor.tenantId);
    return row;
  }

  async update(actor: Actor, id: string, input: UpdateContentRuleInput): Promise<ContentRuleRow> {
    const row = await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const existing = (
        await client.query<ContentRuleRow>(
          `SELECT ${COLUMNS} FROM messaging_content_rules WHERE id=$1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!existing) throw new NotFoundException('Content rule not found');
      const prepared = this.prepare(input, existing);
      await this.assertScopeExists(client, prepared.smscId, prepared.customerId);
      if (prepared.enabled) await this.assertCapacity(client, prepared.matchType, id);
      const updated = (
        await runUnique(prepared.name, () =>
          client.query<ContentRuleRow>(
            `UPDATE messaging_content_rules
              SET name=$2, description=$3, match_field=$4, match_type=$5, pattern=$6,
                  case_sensitive=$7, action=$8, smsc_id=$9, customer_id=$10, enabled=$11,
                  priority=$12, expires_at=$13, reason=$14, updated_at=now(),
                  quarantined_at = CASE WHEN $11 THEN NULL ELSE quarantined_at END,
                  quarantine_reason = CASE WHEN $11 THEN NULL ELSE quarantine_reason END
            WHERE id=$1 RETURNING ${COLUMNS}`,
            [
              id,
              prepared.name,
              prepared.description,
              prepared.matchField,
              prepared.matchType,
              prepared.pattern,
              prepared.caseSensitive,
              prepared.action,
              prepared.smscId,
              prepared.customerId,
              prepared.enabled,
              prepared.priority,
              prepared.expiresAt,
              prepared.reason,
            ],
          ),
        )
      ).rows[0];
      await this.audit(client, actor, 'updated', id, updated, existing);
      return updated;
    });
    this.invalidate(actor.tenantId);
    return row;
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      const deleted = (
        await client.query<{ id: string; name: string }>(
          'DELETE FROM messaging_content_rules WHERE id=$1 RETURNING id::text,name',
          [id],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('Content rule not found');
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'messaging_content_rule.deleted',
          'messaging_content_rule',
          deleted.id,
          JSON.stringify({ name: deleted.name }),
        ],
      );
    });
    this.invalidate(actor.tenantId);
  }

  // ---- helpers -------------------------------------------------------------

  private async audit(
    client: PoolClient,
    actor: Actor,
    verb: string,
    id: string,
    next: ContentRuleRow,
    previous?: ContentRuleRow,
  ): Promise<void> {
    await client.query(
      'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.tenantId,
        actor.userId,
        `messaging_content_rule.${verb}`,
        'messaging_content_rule',
        id,
        previous ? JSON.stringify(summarise(previous)) : null,
        JSON.stringify(summarise(next)),
        next.reason,
      ],
    );
  }

  /**
   * Enforces the per-tenant ceilings that keep the send-path cost bounded. A
   * rule set that outgrows them is refused at write time, where an operator can
   * do something about it, rather than degrading every send silently.
   */
  private async assertCapacity(
    client: PoolClient,
    matchType: ContentMatchType,
    excludeId: string | null,
  ): Promise<void> {
    const counts = (
      await client.query<{ total: string; regex: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE match_type='regex')::text AS regex
           FROM messaging_content_rules
          WHERE enabled = true AND ($1::uuid IS NULL OR id <> $1::uuid)`,
        [excludeId],
      )
    ).rows[0];
    if (Number(counts.total) >= MAX_RULES_PER_TENANT)
      throw new BadRequestException(
        `A tenant may have at most ${MAX_RULES_PER_TENANT} enabled content rules; disable or delete one first`,
      );
    if (matchType === 'regex' && Number(counts.regex) >= MAX_REGEX_RULES_PER_TENANT)
      throw new BadRequestException(
        `A tenant may have at most ${MAX_REGEX_RULES_PER_TENANT} enabled regex content rules; ` +
          'regex is the expensive match type and its count is capped to bound send-path latency',
      );
  }

  /** A rule scoped to something that does not exist would silently never fire. */
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
          `smscId "${smscId}" is not one of your tenant's SMSCs; a rule scoped to it would never match`,
        );
    }
    if (customerId) {
      const found = (await client.query('SELECT 1 FROM customers WHERE id=$1', [customerId]))
        .rows[0];
      if (!found) throw new NotFoundException('Customer not found');
    }
  }

  /**
   * Validates and defaults an input against the row being replaced (create
   * passes `undefined`, so every required field must be present).
   */
  private prepare(input: UpdateContentRuleInput, existing: ContentRuleRow | undefined) {
    const pick = <T>(value: T | undefined | null, fallback: T): T =>
      value === undefined ? fallback : (value as T);

    const name = input.name !== undefined ? String(input.name).trim() : (existing?.name ?? '');
    if (!name) throw new BadRequestException('name is required');
    if (name.length > 200) throw new BadRequestException('name must be at most 200 characters');

    const matchField = parseMatchField(input.matchField ?? existing?.match_field);
    const matchType = parseMatchType(input.matchType ?? existing?.match_type);
    const action = parseAction(input.action ?? existing?.action);
    const pattern = validatePattern(matchType, input.pattern ?? existing?.pattern);
    const priority = parsePriority(
      input.priority ?? (existing ? existing.priority : undefined),
      100,
    );

    const smscId = normaliseScope(
      input.smscId === undefined ? existing?.smsc_id : input.smscId,
      'smscId',
      ENGINE_ID,
      'an engine-level SMSC identifier',
    );
    const customerId = normaliseScope(
      input.customerId === undefined ? existing?.customer_id : input.customerId,
      'customerId',
      UUID,
      'a UUID',
    );

    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined) expiresAt = input.expiresAt ?? null;
    else if (existing?.expires_at)
      expiresAt =
        existing.expires_at instanceof Date ? existing.expires_at : new Date(existing.expires_at);

    return {
      name,
      description: pick(
        input.description === undefined ? undefined : (input.description ?? null),
        existing?.description ?? null,
      ),
      matchField,
      matchType,
      pattern,
      caseSensitive: pick(input.caseSensitive, existing?.case_sensitive ?? false),
      action,
      smscId,
      customerId,
      enabled: pick(input.enabled, existing?.enabled ?? true),
      priority,
      expiresAt,
      reason: pick(
        input.reason === undefined ? undefined : (input.reason ?? null),
        existing?.reason ?? null,
      ),
    };
  }
}

/**
 * Turns the `(tenant_id, name)` unique violation into a 409 naming the rule.
 * A duplicate name is an operator mistake, and an operator mistake is never a
 * 500 — nor a stack trace with a Postgres error code in it.
 */
async function runUnique<T>(name: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ConflictException(`A content rule named "${name}" already exists`);
    throw error;
  }
}

function normaliseScope(
  value: string | null | undefined,
  name: string,
  pattern: RegExp,
  described: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!pattern.test(text)) throw new BadRequestException(`${name} must be ${described}`);
  return text;
}

/** The fields worth keeping in an audit row; the counters are not policy. */
function summarise(row: ContentRuleRow) {
  return {
    name: row.name,
    matchField: row.match_field,
    matchType: row.match_type,
    pattern: row.pattern,
    caseSensitive: row.case_sensitive,
    action: row.action,
    smscId: row.smsc_id,
    customerId: row.customer_id,
    enabled: row.enabled,
    priority: row.priority,
    expiresAt: row.expires_at,
  };
}
