/**
 * Message send priority, shared by the single-message composer, the Bulk Send
 * campaign form and the Live Queue resend.
 *
 * THE CONTRACT, as implemented by `parseMessagePriority`
 * (`backend/src/engine/kamex-sqlbox.repository.ts`) and applied identically at
 * every one of these entry points:
 *
 *   POST /api/v1/messages              console.controllers.ts `submit`
 *   POST /api/v1/bulk-send             messaging-depth/bulk-send.controller.ts
 *   POST /api/v1/queue-console/resend  queue-console/queue-console.controller.ts
 *
 *   priority   a whole number 0…3, or the key omitted entirely
 *
 * NULL AND 0 ARE DIFFERENT, AND NEITHER IS A DEFAULT FOR THE OTHER.
 *
 * Omitted means "no preference": the column stays NULL, the patched sqlbox
 * driver decodes it as MSG_PARAM_UNDEFINED, and the message behaves exactly as
 * every message did before priority existed. 0 is the real, LOWEST SMPP level
 * — it sorts below every message that named a level. A select whose first
 * option submitted 0 would therefore silently demote all traffic, which is why
 * the absent state here is the empty string and {@link priorityFields} omits
 * the key entirely rather than sending 0 or null.
 *
 * 4 and above is a 400 from the API: SMPP `priority_flag` is a 2-bit field.
 */

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 3;

/**
 * The control's value. A string, never a number, so the absent state ('') can
 * never be confused with the real level 0 by a truthiness check.
 */
export type PriorityChoice = '' | '0' | '1' | '2' | '3';

/** The genuinely-absent default. */
export const PRIORITY_UNSET: PriorityChoice = '';

export interface PriorityLevel {
  value: PriorityChoice;
  label: string;
  /** One line explaining what choosing this level actually means. */
  hint: string;
}

/**
 * Levels exactly as the engine orders them: bearerbox's per-SMSC outbound queue
 * is a max-heap on `sms.priority` (gw/sms.c `sms_priority_compare`), so a HIGHER
 * number leaves first, matching SMPP where 3 is the highest priority_flag.
 * Levels 1 and 2 carry no name in the specification and are not given an
 * invented one here.
 */
export const PRIORITY_LEVELS: PriorityLevel[] = [
  {
    value: '',
    label: 'No preference (default)',
    hint: 'The priority column is left unset, exactly as every message was sent before this control existed. This is NOT the same as choosing 0.',
  },
  {
    value: '0',
    label: '0 — bulk, the lowest real level',
    hint: 'A real SMPP level, not a default: 0 sorts BELOW every message that left priority unset. Use it to hold a large campaign behind transactional traffic on a shared bind.',
  },
  { value: '1', label: '1 — above bulk', hint: 'Leaves a backlog ahead of level 0.' },
  { value: '2', label: '2 — above level 1', hint: 'Leaves a backlog ahead of levels 0 and 1.' },
  {
    value: '3',
    label: '3 — highest',
    hint: 'The highest value SMPP priority_flag can carry; anything above 3 is rejected by the API.',
  },
];

/**
 * The honest limit, stated wherever the control appears. An operator who reads
 * "priority" as "send this faster" will report a bug the first time they test
 * it on a quiet link, because on a quiet link it genuinely does nothing.
 */
export const PRIORITY_CAVEAT =
  'Priority only changes anything when a backlog exists. It reorders the engine’s per-SMSC ' +
  'outbound queue — it does not make the link faster. On an idle bind that drains in under a ' +
  'second, a priority 3 and a priority 0 message submitted together still leave in the order ' +
  'they arrived, and priority cannot preempt a segment already handed to the SMPP link.';

/**
 * Bulk gets the strongest wording because bulk is where priority earns its
 * keep: a campaign is how a backlog gets created in the first place, so this is
 * the one composer where the control reliably changes what an operator sees.
 */
export const PRIORITY_BULK_CAVEAT =
  'A campaign is how a backlog forms, so this is the one send path where priority reliably ' +
  'changes the order traffic leaves in. Every recipient of this campaign inherits the level set ' +
  'here. Queue thousands of recipients at 0 and they stay behind transactional traffic sharing ' +
  'the bind; queue them at 3 and they push in front of it. It is still only a reordering: on an ' +
  'idle bind with nothing else queued it changes nothing observable, it does not make the link ' +
  'faster, and it cannot preempt a segment already handed to the SMPP link.';

/** Resend replays a batch, which is itself a backlog — the same trade, stated for it. */
export const PRIORITY_RESEND_CAVEAT =
  'A replay is a backlog you are creating on purpose, so the level matters here. Send a large ' +
  'replay at 0 to keep it behind live traffic, or at 3 to push it in front. The original ' +
  'message’s own priority is deliberately not reused — a resend is a new decision about urgency. ' +
  'On an idle bind it still changes nothing observable.';

/** Why "unset" is an answer and not a missing one, for the hint under the select. */
export const PRIORITY_UNSET_NOTE =
  'Leaving this on “No preference” omits the field entirely; the API treats that as no ' +
  'preference and it is not the same as choosing 0, which is the lowest real SMPP level.';

/**
 * The request fields for a send at this priority, exactly as the API names
 * them. Returns an EMPTY object for the unset choice — the key is absent from
 * the request body rather than present as `0` or `null`.
 */
export function priorityFields(choice: PriorityChoice): Record<string, number> {
  if (choice === PRIORITY_UNSET) return {};
  return { priority: Number(choice) };
}

/** Guards a value read back from a row or a form before it is used as a choice. */
export function isPriorityChoice(value: unknown): value is PriorityChoice {
  return value === '' || value === '0' || value === '1' || value === '2' || value === '3';
}

/**
 * Grid cell text. `unset` rather than the usual `—`: on this column an absent
 * value is a real, meaningful state, not missing data.
 */
export function priorityCellLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'unset';
  const parsed = Number(value);
  return Number.isInteger(parsed) ? String(parsed) : String(value);
}

/** Tooltip for a grid cell, naming the level so the number is not bare. */
export function priorityCellHint(value: unknown): string {
  if (value === null || value === undefined || value === '')
    return 'No priority was requested for this message (not the same as level 0).';
  const parsed = Number(value);
  const level = PRIORITY_LEVELS.find((entry) => entry.value === String(parsed));
  return level ? `SMPP priority_flag ${parsed} — ${level.label}` : `priority ${String(value)}`;
}
