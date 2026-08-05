import { BadRequestException } from '@nestjs/common';
import { assertSafeRegexPattern, compileSafeRegex, runBoundedRegex } from './content-rule-regex';

/**
 * THE CONTENT FILTER RULE MODEL AND ITS EVALUATION ORDER.
 *
 * This file is pure: no database, no Nest, no I/O. It defines what a rule is,
 * the total order rules are evaluated in, and the verdict that order produces.
 * The service around it does storage, caching and auditing; keeping the decision
 * itself pure is what makes the precedence testable in isolation and what lets
 * the preview endpoint answer "what would happen?" with the *same* code the send
 * path runs, rather than a re-implementation that drifts.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RULE MATCHES ON
 * ---------------------------------------------------------------------------
 * `field`: `body` | `sender` | `recipient` | `any`.
 *   `recipient` is matched against the CANONICAL digits-only MSISDN produced by
 *   routing-depth/msisdn.ts, the same value the blocklist and the router use, so
 *   `+256700000000` and `00256700000000` are one recipient and not three. `any`
 *   matches if the pattern hits body, sender OR recipient.
 *
 * `matchType`: `substring` | `exact` | `prefix` | `regex`.
 *   Four, deliberately, and no more. `substring` is what a keyword rule actually
 *   is ("does this message mention LOAN"). `exact` is what a sender-ID or
 *   short-code rule is. `prefix` is what an MSISDN-range or sender-namespace
 *   rule is, and it is the one the router already speaks. `regex` covers what
 *   the other three cannot, and pays for it with the write-time safety analysis
 *   in content-rule-regex.ts. A `suffix` type was left out because nothing in
 *   SMS routing is suffix-addressed, and `glob` was left out because it is a
 *   worse-specified regex.
 *
 * `caseSensitive` defaults to FALSE. Keyword filtering that misses `LOAN`
 * because the rule says `loan` is filtering that does not work.
 *
 * ---------------------------------------------------------------------------
 * SCOPE
 * ---------------------------------------------------------------------------
 * `smscId` (engine-level `smsc_definitions.engine_id`) narrows a rule to traffic
 * bound for ONE carrier — "no promotional keywords over the MTN bind". NULL
 * means every carrier.
 *
 * `customerId` narrows a rule to one customer's traffic. NULL means every
 * customer of the tenant.
 *
 * Scope NARROWS; it never broadens. A rule out of scope simply does not
 * participate, and the next rule in the order decides.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE: FIRST MATCH WINS, OVER ONE TOTAL ORDER
 * ---------------------------------------------------------------------------
 * Rules are sorted by
 *
 *     (priority ASC, created_at ASC, id ASC)
 *
 * and the FIRST rule that matches decides — `allow` means the message proceeds
 * and NO later rule is consulted; `block` means it is refused naming that rule.
 * With no match at all the message is allowed: content filtering is opt-in, and
 * a tenant with no rules has no behaviour change.
 *
 * WHY FIRST-MATCH-WINS AND NOT "ALLOW ALWAYS WINS".
 *   1. It is the model operators already have in their hands. Firewall ACLs,
 *      Kannel's own ordered `sms-service` groups and every router access list
 *      work this way, so the mental model transfers and the ordering is visible.
 *   2. It makes exactly ONE rule responsible for every decision. The question
 *      this feature exists to answer is "why did this message not go out?", and
 *      the honest answer is a single rule id and name — not "the block set won
 *      the argument with the allow set".
 *   3. It is strictly more expressive. "Allow always wins" cannot express
 *      "block this one sender even though this customer is broadly permitted",
 *      because the broad allow would swallow it; you would need a second
 *      mechanism. First-match-wins expresses BOTH policies: put allows first for
 *      allow-precedence, put blocks first for block-precedence. The operator
 *      chooses per rule, by priority, and can see the choice.
 *
 * TIE-BREAKS ARE TOTAL, NEVER AMBIGUOUS. Two rules with the same `priority` are
 * ordered by creation time (the older rule keeps the behaviour it already had —
 * adding a rule never silently changes the meaning of an existing one), and two
 * created in the same transaction are ordered by id. There is no input for
 * which the outcome depends on row order coming back from the database.
 *
 * The order is DATA: {@link compareRules} is one comparator, applied once when
 * the rule set is loaded, and {@link evaluateContent} is a single loop over the
 * sorted array. There is no second place where precedence is decided.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 * Evaluation is O(rules) with no I/O — the rule set is loaded once per tenant
 * per cache window (see ContentFilterService). Substring/exact/prefix are linear
 * string operations over an SMS-sized subject. Regex is bounded by
 * content-rule-regex.ts. A tenant is capped at {@link MAX_RULES_PER_TENANT}
 * enabled rules and {@link MAX_REGEX_RULES_PER_TENANT} enabled regex rules, so
 * the per-send cost has a ceiling rather than growing with the admin's
 * enthusiasm.
 */

export type ContentMatchField = 'body' | 'sender' | 'recipient' | 'any';
export type ContentMatchType = 'substring' | 'exact' | 'prefix' | 'regex';
export type ContentRuleAction = 'block' | 'allow';

export const CONTENT_MATCH_FIELDS: readonly ContentMatchField[] = [
  'body',
  'sender',
  'recipient',
  'any',
];
export const CONTENT_MATCH_TYPES: readonly ContentMatchType[] = [
  'substring',
  'exact',
  'prefix',
  'regex',
];
export const CONTENT_RULE_ACTIONS: readonly ContentRuleAction[] = ['block', 'allow'];

/** Ceiling on enabled rules per tenant, so send-path cost is bounded. */
export const MAX_RULES_PER_TENANT = 500;
/** Ceiling on enabled REGEX rules per tenant; these are the expensive ones. */
export const MAX_REGEX_RULES_PER_TENANT = 50;
/** Longest literal (non-regex) pattern accepted. */
export const MAX_LITERAL_PATTERN_LENGTH = 512;

/** A rule row as stored. Timestamps are ISO strings or Dates, as pg returns them. */
export interface ContentRuleRow {
  id: string;
  name: string;
  description: string | null;
  match_field: ContentMatchField;
  match_type: ContentMatchType;
  pattern: string;
  case_sensitive: boolean;
  action: ContentRuleAction;
  smsc_id: string | null;
  customer_id: string | null;
  enabled: boolean;
  priority: number;
  expires_at: string | Date | null;
  reason: string | null;
  match_count: string | number;
  last_matched_at: string | Date | null;
  quarantined_at: string | Date | null;
  quarantine_reason: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/** A rule prepared for evaluation: regex compiled once, casing folded once. */
export interface CompiledContentRule {
  id: string;
  name: string;
  field: ContentMatchField;
  matchType: ContentMatchType;
  pattern: string;
  /** Case-folded pattern for the literal match types; undefined for regex. */
  needle?: string;
  caseSensitive: boolean;
  action: ContentRuleAction;
  smscId: string | null;
  customerId: string | null;
  priority: number;
  reason: string | null;
  createdAtMs: number;
  regex?: RegExp;
  /** Set when compiling the stored pattern failed; such a rule never matches. */
  compileError?: string;
}

/** The message being judged. */
export interface ContentFilterContext {
  sender: string;
  /** Canonical digits-only destination. */
  recipient: string;
  body: string;
  /** Engine-level SMSC id, when the bind is already known. */
  smscId?: string | null;
  customerId?: string | null;
}

export interface ContentRuleMatch {
  ruleId: string;
  ruleName: string;
  action: ContentRuleAction;
  field: ContentMatchField;
  matchType: ContentMatchType;
  pattern: string;
  priority: number;
  /** Which of body/sender/recipient actually matched (`any` resolves to one). */
  matchedOn: 'body' | 'sender' | 'recipient';
  reason: string | null;
}

export interface ContentFilterVerdict {
  allowed: boolean;
  /** The rule that decided, or null when nothing matched. */
  decidedBy: ContentRuleMatch | null;
  /** Human sentence naming the rule; safe to put in an error and an audit row. */
  reason: string;
  /** How many rules were in scope and actually tested. */
  rulesEvaluated: number;
  /**
   * Rules whose regex blew the execution budget during THIS evaluation. The
   * caller quarantines them. Empty on every healthy evaluation.
   */
  overBudgetRuleIds: string[];
}

/** Total order: priority, then age, then id. See the class doc above. */
export function compareRules(a: CompiledContentRule, b: CompiledContentRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Prepares a stored row for evaluation. A regex that will not compile does not
 * throw here: it is recorded on the rule as `compileError` and the rule never
 * matches, so one corrupt row cannot take the send path down for a tenant. The
 * write path refuses such patterns in the first place, so this is defence for
 * rows that predate a validation change or arrived by direct SQL.
 */
export function compileRule(row: ContentRuleRow): CompiledContentRule {
  const base: CompiledContentRule = {
    id: row.id,
    name: row.name,
    field: row.match_field,
    matchType: row.match_type,
    pattern: row.pattern,
    caseSensitive: row.case_sensitive,
    action: row.action,
    smscId: row.smsc_id,
    customerId: row.customer_id,
    priority: Number(row.priority),
    reason: row.reason,
    createdAtMs: toMs(row.created_at),
  };
  if (row.match_type === 'regex') {
    try {
      base.regex = compileSafeRegex(row.pattern, row.case_sensitive);
    } catch (error) {
      base.compileError = String((error as Error).message ?? error);
    }
    return base;
  }
  base.needle = row.case_sensitive ? row.pattern : row.pattern.toLowerCase();
  return base;
}

/** Which subjects a rule looks at, in a fixed order so `any` is deterministic. */
function subjectsFor(
  field: ContentMatchField,
  context: ContentFilterContext,
): Array<{ name: 'body' | 'sender' | 'recipient'; value: string }> {
  const body = { name: 'body' as const, value: context.body ?? '' };
  const sender = { name: 'sender' as const, value: context.sender ?? '' };
  const recipient = { name: 'recipient' as const, value: context.recipient ?? '' };
  switch (field) {
    case 'body':
      return [body];
    case 'sender':
      return [sender];
    case 'recipient':
      return [recipient];
    default:
      // `any`: body first because that is what an operator writing a keyword
      // rule means; then sender, then recipient. Fixed, so `matchedOn` is
      // reproducible for the same inputs.
      return [body, sender, recipient];
  }
}

/**
 * Is this rule in scope for this message?
 *
 * An SMSC-scoped rule is only in scope once the bind is known. When `smscId` is
 * undefined/null on the context the rule is SKIPPED rather than assumed to
 * apply — see ContentFilterService for why the send path defers evaluation in
 * that case instead of guessing.
 */
export function ruleInScope(rule: CompiledContentRule, context: ContentFilterContext): boolean {
  if (rule.customerId && rule.customerId !== (context.customerId ?? null)) return false;
  if (rule.smscId && rule.smscId !== (context.smscId ?? null)) return false;
  return true;
}

function literalMatch(rule: CompiledContentRule, subject: string): boolean {
  const needle = rule.needle ?? '';
  if (!needle) return false;
  const haystack = rule.caseSensitive ? subject : subject.toLowerCase();
  switch (rule.matchType) {
    case 'exact':
      return haystack === needle;
    case 'prefix':
      return haystack.startsWith(needle);
    default:
      return haystack.includes(needle);
  }
}

/** Tests one rule. Returns the match, or null. Never throws. */
export function matchRule(
  rule: CompiledContentRule,
  context: ContentFilterContext,
  overBudget: string[],
): ContentRuleMatch | null {
  if (rule.compileError) return null;
  for (const subject of subjectsFor(rule.field, context)) {
    let hit = false;
    if (rule.matchType === 'regex') {
      if (!rule.regex) return null;
      const result = runBoundedRegex(rule.regex, subject.value);
      if (result.overBudget && !overBudget.includes(rule.id)) overBudget.push(rule.id);
      hit = result.matched;
    } else {
      hit = literalMatch(rule, subject.value);
    }
    if (hit)
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        action: rule.action,
        field: rule.field,
        matchType: rule.matchType,
        pattern: rule.pattern,
        priority: rule.priority,
        matchedOn: subject.name,
        reason: rule.reason,
      };
  }
  return null;
}

/**
 * Evaluates a pre-sorted rule set. FIRST MATCH WINS.
 *
 * `rules` MUST already be sorted with {@link compareRules}; sorting here would
 * pay for it on every send. ContentFilterService sorts once, at load.
 */
export function evaluateContent(
  rules: readonly CompiledContentRule[],
  context: ContentFilterContext,
): ContentFilterVerdict {
  const overBudgetRuleIds: string[] = [];
  let evaluated = 0;
  for (const rule of rules) {
    if (!ruleInScope(rule, context)) continue;
    evaluated += 1;
    const match = matchRule(rule, context, overBudgetRuleIds);
    if (!match) continue;
    return {
      allowed: match.action === 'allow',
      decidedBy: match,
      reason: describeMatch(match),
      rulesEvaluated: evaluated,
      overBudgetRuleIds,
    };
  }
  return {
    allowed: true,
    decidedBy: null,
    reason: evaluated
      ? `no content rule matched (${evaluated} in scope)`
      : 'no content rule is in scope',
    rulesEvaluated: evaluated,
    overBudgetRuleIds,
  };
}

/**
 * Every rule that matches, in evaluation order, with the deciding one flagged.
 * This is what the preview endpoint returns: an operator testing a rule needs
 * to see the rule they just wrote match EVEN IF an earlier rule decides first,
 * otherwise "my rule does nothing" and "my rule is shadowed" look identical.
 */
export function explainContent(
  rules: readonly CompiledContentRule[],
  context: ContentFilterContext,
): {
  verdict: ContentFilterVerdict;
  matches: Array<ContentRuleMatch & { shadowed: boolean }>;
  inScope: number;
  skippedOutOfScope: number;
} {
  const overBudgetRuleIds: string[] = [];
  const matches: Array<ContentRuleMatch & { shadowed: boolean }> = [];
  let inScope = 0;
  let skipped = 0;
  let decided: ContentRuleMatch | null = null;
  let evaluatedUntilDecision = 0;

  for (const rule of rules) {
    if (!ruleInScope(rule, context)) {
      skipped += 1;
      continue;
    }
    inScope += 1;
    if (!decided) evaluatedUntilDecision += 1;
    const match = matchRule(rule, context, overBudgetRuleIds);
    if (!match) continue;
    if (!decided) {
      decided = match;
      matches.push({ ...match, shadowed: false });
    } else {
      matches.push({ ...match, shadowed: true });
    }
  }

  const verdict: ContentFilterVerdict = decided
    ? {
        allowed: decided.action === 'allow',
        decidedBy: decided,
        reason: describeMatch(decided),
        rulesEvaluated: evaluatedUntilDecision,
        overBudgetRuleIds,
      }
    : {
        allowed: true,
        decidedBy: null,
        reason: inScope
          ? `no content rule matched (${inScope} in scope)`
          : 'no content rule is in scope',
        rulesEvaluated: inScope,
        overBudgetRuleIds,
      };
  return { verdict, matches, inScope, skippedOutOfScope: skipped };
}

/** The sentence an operator reads in the refusal and in the decision row. */
export function describeMatch(match: ContentRuleMatch): string {
  const scope = match.field === 'any' ? `${match.matchedOn} (field: any)` : match.field;
  const head =
    `content rule "${match.ruleName}" (${match.ruleId}, priority ${match.priority}) ` +
    `${match.action === 'block' ? 'blocked' : 'allowed'} this message: ` +
    `${match.matchType} match on ${scope} against ${JSON.stringify(match.pattern)}`;
  return match.reason ? `${head} — ${match.reason}` : head;
}

// ---------------------------------------------------------------------------
// Write-time validation
// ---------------------------------------------------------------------------

/** Validates a pattern for a match type, refusing anything unrunnable. */
export function validatePattern(matchType: ContentMatchType, pattern: unknown): string {
  if (typeof pattern !== 'string' || !pattern.length)
    throw new BadRequestException('pattern is required');
  if (matchType === 'regex') {
    assertSafeRegexPattern(pattern);
    return pattern;
  }
  if (pattern.length > MAX_LITERAL_PATTERN_LENGTH)
    throw new BadRequestException(
      `pattern must be at most ${MAX_LITERAL_PATTERN_LENGTH} characters`,
    );
  // A literal pattern of only whitespace matches nearly every message and is
  // almost certainly a mistake rather than a policy.
  if (!pattern.trim())
    throw new BadRequestException('pattern must contain something other than whitespace');
  return pattern;
}

export function parseMatchField(value: unknown): ContentMatchField {
  if (!CONTENT_MATCH_FIELDS.includes(value as ContentMatchField))
    throw new BadRequestException(`matchField must be one of ${CONTENT_MATCH_FIELDS.join(', ')}`);
  return value as ContentMatchField;
}

export function parseMatchType(value: unknown): ContentMatchType {
  if (!CONTENT_MATCH_TYPES.includes(value as ContentMatchType))
    throw new BadRequestException(`matchType must be one of ${CONTENT_MATCH_TYPES.join(', ')}`);
  return value as ContentMatchType;
}

export function parseAction(value: unknown): ContentRuleAction {
  if (!CONTENT_RULE_ACTIONS.includes(value as ContentRuleAction))
    throw new BadRequestException(`action must be one of ${CONTENT_RULE_ACTIONS.join(', ')}`);
  return value as ContentRuleAction;
}

export function parsePriority(value: unknown, fallback = 100): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000)
    throw new BadRequestException('priority must be an integer between 0 and 1000000');
  return parsed;
}
