/**
 * What a matched route rule DOES to a message, beyond choosing an SMSC
 * (SMS STUDIO Features, pages 4 and 6–7; migration 052).
 *
 * Three things a rule can now do that it could not before:
 *
 *   - **drop** it, with a stated reason
 *   - **rewrite the sender**, which is how a blocked or throttled sender id is
 *     worked around without editing every application that submits
 *   - **rewrite the recipient or the body**, rarer and more heavily audited
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESULT CARRIES THE BEFORE AS WELL AS THE AFTER
 * ---------------------------------------------------------------------------
 * An override is invisible after the fact unless something records it. Six
 * months from now the question is "the customer says they sent from URASMS and
 * the subscriber saw 7077 — what happened", and the only defensible answer
 * names the rule and shows both values. So {@link applyRouteRule} returns the
 * change set, not just the changed message, and the caller persists it on the
 * route decision it already writes on every send.
 */

export type RouteAction = 'route' | 'drop';

export interface RouteRuleEffect {
  action: RouteAction;
  overrideSender?: string | null;
  overrideRecipient?: string | null;
  overrideText?: string | null;
  dropReason?: string | null;
}

export interface OutboundMessage {
  sender: string | null;
  recipient: string;
  text: string;
}

/** One field the rule rewrote, with what it was and what it became. */
export interface FieldChange {
  from: string | null;
  to: string;
}

export type OverrideSet = Partial<Record<'sender' | 'recipient' | 'text', FieldChange>>;

export type RouteOutcome =
  | {
      decision: 'send';
      message: OutboundMessage;
      /** Empty object when the rule changed nothing. Never null. */
      overrides: OverrideSet;
      /** Human sentence for the audit trail, or null when nothing changed. */
      summary: string | null;
    }
  | {
      decision: 'drop';
      reason: string;
      summary: string;
    };

/**
 * Applies a rule's action and overrides to a message.
 *
 * Pure, and takes the message rather than mutating it, so the caller always
 * still holds the original — which is what the audit entry needs.
 */
export function applyRouteRule(
  message: OutboundMessage,
  rule: RouteRuleEffect,
  ruleName = 'a routing rule',
): RouteOutcome {
  if (rule.action === 'drop') {
    const reason = String(rule.dropReason ?? '').trim();
    return {
      decision: 'drop',
      // The schema requires a reason, but a rule written before 052 or by a
      // direct SQL edit could still arrive without one. Saying "no reason
      // recorded" is honest; inventing a plausible one is not.
      reason: reason || 'No reason recorded on the rule.',
      summary: `Dropped by ${ruleName}: ${reason || 'no reason recorded on the rule'}.`,
    };
  }

  const overrides: OverrideSet = {};
  const next: OutboundMessage = { ...message };

  const sender = clean(rule.overrideSender);
  if (sender !== null && sender !== message.sender) {
    overrides.sender = { from: message.sender, to: sender };
    next.sender = sender;
  }

  const recipient = clean(rule.overrideRecipient);
  if (recipient !== null && recipient !== message.recipient) {
    overrides.recipient = { from: message.recipient, to: recipient };
    next.recipient = recipient;
  }

  const text = clean(rule.overrideText);
  if (text !== null && text !== message.text) {
    // Only the LENGTH of the original body is recorded, not the body itself.
    // The decision row is not a masked read path and lands in exports, so
    // copying subscriber content into it would route around Phase 6 entirely.
    overrides.text = { from: `${message.text.length} characters`, to: text };
    next.text = text;
  }

  return {
    decision: 'send',
    message: next,
    overrides,
    summary: describeOverrides(overrides, ruleName),
  };
}

/**
 * The change set in words, or null when nothing changed.
 *
 * Null and not an empty string: "the rule changed nothing" and "the rule
 * changed something we could not describe" must not render the same.
 */
export function describeOverrides(overrides: OverrideSet, ruleName = 'a routing rule'): string | null {
  const parts: string[] = [];
  if (overrides.sender)
    parts.push(`sender ${overrides.sender.from ?? '(none)'} → ${overrides.sender.to}`);
  if (overrides.recipient)
    parts.push(`recipient ${overrides.recipient.from} → ${overrides.recipient.to}`);
  if (overrides.text) parts.push(`body replaced (was ${overrides.text.from})`);
  return parts.length ? `${ruleName} rewrote ${parts.join(', ')}.` : null;
}

/**
 * Why this override would be rejected, or null.
 *
 * Enforced here as well as by the CHECK constraints, because a 400 naming the
 * field is a usable answer and a constraint-violation string is not.
 */
export function describeEffectProblem(rule: Partial<RouteRuleEffect>): string | null {
  const action = rule.action ?? 'route';
  if (action !== 'route' && action !== 'drop')
    return `action must be "route" or "drop"; received "${action}".`;

  if (action === 'drop') {
    if (String(rule.dropReason ?? '').trim().length < 3)
      return 'A dropping rule must state why, in at least 3 characters. Traffic that vanishes with no explanation is the worst outcome this feature can produce.';
    if (rule.overrideSender || rule.overrideRecipient || rule.overrideText)
      return 'A dropping rule cannot also carry overrides: nothing is sent, so there is nothing to rewrite.';
    return null;
  }

  for (const [field, value] of [
    ['overrideSender', rule.overrideSender],
    ['overrideRecipient', rule.overrideRecipient],
    ['overrideText', rule.overrideText],
  ] as const) {
    if (value !== undefined && value !== null && !String(value).trim())
      return `${field} was sent but is blank. Omit it, or give it a value — a blank would erase the field on every matching message.`;
  }
  return null;
}

/** Trims, and treats blank or absent as "no override". */
function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}
