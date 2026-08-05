import { BadRequestException } from '@nestjs/common';
import { digitsOnly, normalizeMsisdn } from '../routing-depth/msisdn';

/**
 * MO (MOBILE-ORIGINATED) ROUTING: MATCHING AN INBOUND MESSAGE, AND FANNING IT
 * OUT TO SEVERAL DESTINATIONS.
 *
 * This file is pure — no database, no Nest, no I/O — for the same reason
 * content-filter.ts is: the matching decision is the part that must be
 * exhaustively testable, and the preview/CRUD/dispatch layers around it should
 * not be able to grow a second copy of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RULE MATCHES ON
 * ---------------------------------------------------------------------------
 * All four criteria are ANDed, and each is optional (an omitted criterion means
 * "any"). A rule with no criteria at all is a catch-all, which is legitimate
 * and is how "forward everything to our CRM" is expressed.
 *
 *   smscId          the RECEIVING bind (`smsc_definitions.engine_id`) — "traffic
 *                   that arrived over the MTN connection"
 *   destination     the short code / long number the subscriber texted, matched
 *                   `exact` or by `prefix` against the canonical digits
 *   senderPrefix    a prefix of the originating MSISDN's canonical digits
 *   keyword         a word or phrase in the body: `first_word` (the classic SMS
 *                   keyword convention — "STOP", "BAL", "JOIN"), `substring`,
 *                   or `exact` (the whole trimmed body)
 *
 * MSISDNs on BOTH sides go through the shared normaliser, so a rule written for
 * `+256700` matches a sender the engine delivered as `256700…`. A short code
 * (`8080`) is too short to be an MSISDN, so destinations fall back to
 * digits-only comparison — see {@link canonicalAddress}.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE, AND WHY FAN-OUT NEEDS A NON-TERMINAL RULE
 * ---------------------------------------------------------------------------
 * Rules are ordered by `(priority ASC, created_at ASC, id ASC)` — the same total
 * order the content filter uses, because two different precedence models in one
 * codebase is one too many.
 *
 * By default the FIRST matching rule wins and matching stops. That is what makes
 * "STOP goes to the opt-out webhook, everything else goes to the CRM" work with
 * two rules and no bookkeeping.
 *
 * A rule may set `continueAfterMatch`, in which case matching carries on past
 * it. That is how one inbound message is delivered by SEVERAL rules — an audit
 * webhook that should see everything, plus whichever specific rule handles the
 * keyword. Fan-out across DESTINATIONS is the normal case and needs no flag:
 * one rule carries as many destinations as the operator wants.
 */

export type MoDestinationMatchType = 'any' | 'exact' | 'prefix';
export type MoKeywordMatchType = 'any' | 'first_word' | 'substring' | 'exact';
export type MoDeliveryKind = 'webhook' | 'email' | 'sms';

export const MO_DESTINATION_MATCH_TYPES: readonly MoDestinationMatchType[] = [
  'any',
  'exact',
  'prefix',
];
export const MO_KEYWORD_MATCH_TYPES: readonly MoKeywordMatchType[] = [
  'any',
  'first_word',
  'substring',
  'exact',
];
export const MO_DELIVERY_KINDS: readonly MoDeliveryKind[] = ['webhook', 'email', 'sms'];

/** Ceiling on destinations per rule: a fan-out is a fan-out, not a mailing list. */
export const MAX_DESTINATIONS_PER_RULE = 20;

export interface MoRuleRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  match_smsc_id: string | null;
  match_destination: string | null;
  match_destination_type: MoDestinationMatchType;
  match_sender_prefix: string | null;
  match_keyword: string | null;
  match_keyword_type: MoKeywordMatchType;
  case_sensitive: boolean;
  continue_after_match: boolean;
  customer_id: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface MoDestinationRow {
  id: string;
  rule_id: string;
  kind: MoDeliveryKind;
  target: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  max_attempts: number;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

/** A rule with its destinations attached, ready to match. */
export interface CompiledMoRule {
  id: string;
  name: string;
  priority: number;
  smscId: string | null;
  destination: string | null;
  destinationType: MoDestinationMatchType;
  senderPrefix: string | null;
  keyword: string | null;
  keywordType: MoKeywordMatchType;
  caseSensitive: boolean;
  continueAfterMatch: boolean;
  customerId: string | null;
  createdAtMs: number;
  destinations: Array<{
    id: string;
    kind: MoDeliveryKind;
    target: string;
    config: Record<string, unknown>;
    maxAttempts: number;
  }>;
}

/** An inbound message, as observed. */
export interface MoMessageContext {
  /** Receiving bind (`smsc_definitions.engine_id`), when known. */
  smscId: string | null;
  /** Originating MSISDN, as the engine delivered it. */
  sender: string;
  /** Short code / long number the subscriber texted. */
  receiver: string;
  body: string;
}

export interface MoMatch {
  ruleId: string;
  ruleName: string;
  priority: number;
  /** Which criteria actually constrained the match, for the audit trail. */
  matchedOn: string[];
  destinationCount: number;
  continueAfterMatch: boolean;
}

export interface MoMatchResult {
  matches: MoMatch[];
  rulesEvaluated: number;
  /** True when matching stopped at a terminal rule with rules still unread. */
  stoppedEarly: boolean;
}

function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** The same total order the content filter uses. */
export function compareMoRules(a: CompiledMoRule, b: CompiledMoRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compileMoRule(row: MoRuleRow, destinations: MoDestinationRow[]): CompiledMoRule {
  return {
    id: row.id,
    name: row.name,
    priority: Number(row.priority),
    smscId: row.match_smsc_id,
    destination: row.match_destination ? canonicalAddress(row.match_destination) : null,
    destinationType: row.match_destination_type,
    senderPrefix: row.match_sender_prefix ? digitsOnly(row.match_sender_prefix) : null,
    keyword: row.match_keyword,
    keywordType: row.match_keyword_type,
    caseSensitive: row.case_sensitive,
    continueAfterMatch: row.continue_after_match,
    customerId: row.customer_id,
    createdAtMs: toMs(row.created_at),
    destinations: destinations
      .filter((destination) => destination.rule_id === row.id && destination.enabled)
      .map((destination) => ({
        id: destination.id,
        kind: destination.kind,
        target: destination.target,
        config: destination.config ?? {},
        maxAttempts: Number(destination.max_attempts),
      })),
  };
}

/**
 * Canonical comparison form for an inbound ADDRESS.
 *
 * A subscriber MSISDN normalises to E.164 digits. A short code (`8080`) or an
 * alphanumeric service address does not — it is too short to be E.164 and the
 * normaliser correctly refuses it. Rather than reject those (which would make
 * the feature useless for exactly the short-code traffic MO is mostly about),
 * the fallback is digits-only, and an address with no digits at all is folded
 * to lower case and compared as text.
 */
export function canonicalAddress(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  const normalized = normalizeMsisdn(text);
  if (normalized.digits) return normalized.digits;
  const digits = digitsOnly(text);
  return digits || text.toLowerCase();
}

/** The first whitespace-delimited token of a body. */
export function firstWord(body: string): string {
  return (body ?? '').trim().split(/\s+/, 1)[0] ?? '';
}

function keywordMatches(rule: CompiledMoRule, body: string): boolean {
  if (rule.keywordType === 'any' || !rule.keyword) return true;
  const fold = (value: string) => (rule.caseSensitive ? value : value.toLowerCase());
  const needle = fold(rule.keyword.trim());
  if (!needle) return true;
  switch (rule.keywordType) {
    case 'first_word':
      return fold(firstWord(body)) === needle;
    case 'exact':
      return fold((body ?? '').trim()) === needle;
    default:
      return fold(body ?? '').includes(needle);
  }
}

/** Tests one rule. Returns the match, or null. Pure and total. */
export function matchMoRule(rule: CompiledMoRule, context: MoMessageContext): MoMatch | null {
  const matchedOn: string[] = [];

  if (rule.smscId) {
    if (rule.smscId !== (context.smscId ?? null)) return null;
    matchedOn.push(`smsc=${rule.smscId}`);
  }

  if (rule.destinationType !== 'any' && rule.destination) {
    const receiver = canonicalAddress(context.receiver);
    const hit =
      rule.destinationType === 'exact'
        ? receiver === rule.destination
        : receiver.startsWith(rule.destination);
    if (!hit) return null;
    matchedOn.push(`destination ${rule.destinationType} ${rule.destination}`);
  }

  if (rule.senderPrefix) {
    const sender = canonicalAddress(context.sender);
    if (!sender.startsWith(rule.senderPrefix)) return null;
    matchedOn.push(`sender prefix ${rule.senderPrefix}`);
  }

  if (rule.keywordType !== 'any' && rule.keyword) {
    if (!keywordMatches(rule, context.body)) return null;
    matchedOn.push(`keyword ${rule.keywordType} ${JSON.stringify(rule.keyword)}`);
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    priority: rule.priority,
    matchedOn: matchedOn.length ? matchedOn : ['catch-all (no criteria)'],
    destinationCount: rule.destinations.length,
    continueAfterMatch: rule.continueAfterMatch,
  };
}

/**
 * Matches an inbound message against a PRE-SORTED rule set. First match wins
 * unless the matching rule is non-terminal (`continueAfterMatch`).
 */
export function matchMoRules(
  rules: readonly CompiledMoRule[],
  context: MoMessageContext,
): MoMatchResult {
  const matches: MoMatch[] = [];
  let evaluated = 0;
  for (let index = 0; index < rules.length; index += 1) {
    evaluated += 1;
    const match = matchMoRule(rules[index], context);
    if (!match) continue;
    matches.push(match);
    if (!match.continueAfterMatch)
      return { matches, rulesEvaluated: evaluated, stoppedEarly: index < rules.length - 1 };
  }
  return { matches, rulesEvaluated: evaluated, stoppedEarly: false };
}

// ---------------------------------------------------------------------------
// Write-time validation
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Validates a destination target for its kind.
 *
 * A webhook must be http(s) — and, unless `MO_WEBHOOK_ALLOW_PRIVATE=true`, must
 * not point at a loopback/link-local/metadata address. An MO fan-out is
 * operator-configured server-side request forgery waiting to happen otherwise:
 * the destination is a URL the platform will fetch, on a schedule, with retries.
 */
export function validateDestinationTarget(kind: MoDeliveryKind, target: unknown): string {
  if (typeof target !== 'string' || !target.trim())
    throw new BadRequestException('target is required');
  const text = target.trim();
  if (text.length > 2048) throw new BadRequestException('target must be at most 2048 characters');

  if (kind === 'email') {
    if (!EMAIL.test(text)) throw new BadRequestException('target must be an email address');
    return text;
  }
  if (kind === 'sms') {
    const normalized = normalizeMsisdn(text);
    if (!normalized.digits)
      throw new BadRequestException('target must be a dialable international MSISDN');
    return normalized.digits;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BadRequestException('target must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new BadRequestException('target must be an http or https URL');
  if (!allowPrivateWebhookTargets() && isPrivateHost(url.hostname))
    throw new BadRequestException(
      `webhook target host "${url.hostname}" is a loopback, link-local or private address. ` +
        'Set MO_WEBHOOK_ALLOW_PRIVATE=true only if forwarding to an internal service is intended.',
    );
  return url.toString();
}

export function allowPrivateWebhookTargets(): boolean {
  return String(process.env.MO_WEBHOOK_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';
}

/**
 * Loopback, link-local (including the 169.254.169.254 cloud metadata endpoint),
 * and RFC1918 space. Hostname-based, so it is a guard against configuration
 * mistakes and casual abuse, not against a DNS rebinding attacker — stated
 * rather than overclaimed.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function parseDeliveryKind(value: unknown): MoDeliveryKind {
  if (!MO_DELIVERY_KINDS.includes(value as MoDeliveryKind))
    throw new BadRequestException(`kind must be one of ${MO_DELIVERY_KINDS.join(', ')}`);
  return value as MoDeliveryKind;
}

export function parseDestinationMatchType(value: unknown): MoDestinationMatchType {
  if (value === undefined || value === null || value === '') return 'any';
  if (!MO_DESTINATION_MATCH_TYPES.includes(value as MoDestinationMatchType))
    throw new BadRequestException(
      `matchDestinationType must be one of ${MO_DESTINATION_MATCH_TYPES.join(', ')}`,
    );
  return value as MoDestinationMatchType;
}

export function parseKeywordMatchType(value: unknown): MoKeywordMatchType {
  if (value === undefined || value === null || value === '') return 'any';
  if (!MO_KEYWORD_MATCH_TYPES.includes(value as MoKeywordMatchType))
    throw new BadRequestException(
      `matchKeywordType must be one of ${MO_KEYWORD_MATCH_TYPES.join(', ')}`,
    );
  return value as MoKeywordMatchType;
}
