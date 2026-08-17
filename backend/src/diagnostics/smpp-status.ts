/**
 * SMPP `command_status` decoded into a name, a plain explanation and a
 * suggested check (spec §11).
 *
 * §11 asks the console to "decode SMPP command status into symbolic name and
 * human explanation" and to "provide recommended diagnostic checks, clearly
 * labeled as guidance rather than automated root-cause certainty".
 *
 * What existed was a 13-entry `const COMMAND_STATUS` private to
 * `smsc/smpp-bind-prober.ts`, mapping code to symbolic name only, reachable
 * only from the "test connection" button. Every other surface showed the raw
 * hex — so an operator looking at a failing bind saw `0x00000058` and had to go
 * and look it up.
 *
 * The `guidance` field is deliberately phrased as a thing to CHECK, never as a
 * diagnosis. A code tells you what the carrier refused, not why; presenting a
 * guess as a cause is how an operator spends an hour on the wrong theory.
 */
export interface SmppStatus {
  code: number;
  /** The SMPP v3.4 symbolic name, e.g. ESME_RTHROTTLED. */
  name: string;
  /** What it means, in a sentence, without protocol jargon. */
  meaning: string;
  /** What to look at next. Guidance, not a root cause. */
  guidance: string;
  /**
   * Whether retrying the same message could plausibly succeed.
   *
   * Drives nothing automatically — it is reported so an operator can tell a
   * transient refusal from a permanent one at a glance.
   */
  retryable: boolean;
}

const STATUSES: Record<number, Omit<SmppStatus, 'code'>> = {
  0x00000000: {
    name: 'ESME_ROK',
    meaning: 'Accepted.',
    guidance: 'No action needed.',
    retryable: false,
  },
  0x00000001: {
    name: 'ESME_RINVMSGLEN',
    meaning: 'The message length was not acceptable to the carrier.',
    guidance:
      'Check the encoding and segment count. A UCS-2 body is 70 characters per part, not 160.',
    retryable: false,
  },
  0x00000002: {
    name: 'ESME_RINVCMDLEN',
    meaning: 'The carrier rejected the size of the PDU itself.',
    guidance: 'Usually an optional-parameter problem rather than the message body.',
    retryable: false,
  },
  0x00000003: {
    name: 'ESME_RINVCMDID',
    meaning: 'The carrier does not support the operation that was sent.',
    guidance: 'Check the bind mode: a transmitter bind cannot receive, and vice versa.',
    retryable: false,
  },
  0x00000004: {
    name: 'ESME_RINVBNDSTS',
    meaning: 'The operation is not allowed in the current bind state.',
    guidance: 'Usually a submit on a receiver-only bind, or a submit before the bind completed.',
    retryable: true,
  },
  0x00000005: {
    name: 'ESME_RALYBND',
    meaning: 'This session is already bound.',
    guidance:
      'Often a stale session the carrier has not yet released. Check whether parallel ' +
      'connections exceed what the carrier permits for this account.',
    retryable: true,
  },
  0x0000000a: {
    name: 'ESME_RINVSRCADR',
    meaning: 'The carrier rejected the sender address.',
    guidance:
      'Check the sender ID is registered with this carrier, and that its TON/NPI match what ' +
      'they expect — alphanumeric senders usually need TON 5.',
    retryable: false,
  },
  0x0000000b: {
    name: 'ESME_RINVDSTADR',
    meaning: 'The carrier rejected the destination address.',
    guidance: 'Check the MSISDN is in the format this carrier wants, and is on their network.',
    retryable: false,
  },
  0x0000000d: {
    name: 'ESME_RBINDFAIL',
    meaning: 'The bind was refused.',
    guidance: 'Check credentials, source IP allow-listing and whether the account is enabled.',
    retryable: true,
  },
  0x0000000e: {
    name: 'ESME_RINVPASWD',
    meaning: 'The password was wrong.',
    guidance:
      'Check the credential this SMSC resolves. Note repeated failures may lock the account ' +
      'at the carrier.',
    retryable: false,
  },
  0x0000000f: {
    name: 'ESME_RINVSYSID',
    meaning: 'The system id was not recognised.',
    guidance: 'Check the system id, and that it is the one for THIS environment.',
    retryable: false,
  },
  0x00000014: {
    name: 'ESME_RMSGQFUL',
    meaning: 'The carrier’s message queue is full.',
    guidance: 'Back off and retry. Sustained occurrences mean the account is over its capacity.',
    retryable: true,
  },
  0x00000045: {
    name: 'ESME_RSUBMITFAIL',
    meaning: 'The carrier could not accept the submission, without saying why.',
    guidance:
      'Generic and unhelpful by design. Correlate with the carrier’s own logs, and check ' +
      'whether it coincides with a throughput spike.',
    retryable: true,
  },
  0x00000058: {
    name: 'ESME_RTHROTTLED',
    meaning: 'Messages are being sent faster than this account is allowed to send them.',
    guidance:
      'Compare observed throughput against the contracted rate. Remember Kannel enforces ' +
      '`throughput` PER CONNECTION, so parallel connections multiply the real send rate.',
    retryable: true,
  },
  0x00000061: {
    name: 'ESME_RINVSCHED',
    meaning: 'The scheduled delivery time was rejected.',
    guidance: 'Check the format and that the time is not in the past.',
    retryable: false,
  },
  0x00000062: {
    name: 'ESME_RINVEXPIRY',
    meaning: 'The validity period was rejected.',
    guidance: 'Check it is within the range the carrier allows.',
    retryable: false,
  },
  0x00000064: {
    name: 'ESME_RX_T_APPN',
    meaning: 'The carrier asked for a transient application-level retry.',
    guidance: 'Retry later; this is the carrier explicitly saying "not now".',
    retryable: true,
  },
  0x000000ff: {
    name: 'ESME_RUNKNOWNERR',
    meaning: 'The carrier reported an unspecified error.',
    guidance: 'Nothing can be concluded from the code alone. Correlate with events and logs.',
    retryable: true,
  },
};

/**
 * Decodes a status, including ones not in the table.
 *
 * An unknown code is NEVER silently mapped onto a neighbouring one. SMPP
 * reserves whole ranges for vendor-specific use, so a carrier's 0x400 means
 * whatever that carrier says it means — reporting a plausible-sounding standard
 * name for it would be an invented fact, and the operator would act on it.
 */
export function decodeSmppStatus(code: number): SmppStatus {
  const known = STATUSES[code];
  if (known) return { code, ...known };

  const hex = `0x${code.toString(16).padStart(8, '0')}`;
  // The vendor range is defined by the specification, so this much IS known.
  const vendorSpecific = code >= 0x00000400 && code <= 0x000004ff;
  return {
    code,
    name: hex,
    meaning: vendorSpecific
      ? 'A vendor-specific status. The SMPP specification reserves this range for the carrier to define.'
      : 'This status is not one JKANNEL has a description for.',
    guidance: vendorSpecific
      ? 'Only the carrier can say what this means — check their integration documentation for ' +
        `${hex}.`
      : `Look ${hex} up in the carrier's documentation. Do not assume it matches a similar ` +
        'standard code.',
    retryable: false,
  };
}

/** Every status this build can describe, for a reference table in the console. */
export function knownSmppStatuses(): SmppStatus[] {
  return Object.entries(STATUSES)
    .map(([code, entry]) => ({ code: Number(code), ...entry }))
    .sort((a, b) => a.code - b.code);
}
