import { decodeSmppStatus, knownSmppStatuses } from './smpp-status';

describe('decodeSmppStatus', () => {
  it('decodes a known status into a name, a meaning and a check', () => {
    const status = decodeSmppStatus(0x00000058);
    expect(status.name).toBe('ESME_RTHROTTLED');
    expect(status.meaning).toMatch(/faster than this account is allowed/);
    expect(status.retryable).toBe(true);
  });

  /**
   * §11 asks for "recommended diagnostic checks, clearly labeled as guidance
   * rather than automated root-cause certainty". A code says what the carrier
   * refused, never why — presenting a guess as a cause sends an operator down
   * the wrong path for an hour.
   */
  it('phrases guidance as something to check, not as a diagnosis', () => {
    for (const status of knownSmppStatuses()) {
      if (status.code === 0) continue;
      expect(status.guidance.length).toBeGreaterThan(10);
    }
    expect(decodeSmppStatus(0x00000058).guidance).toMatch(/Compare|Check|Correlate|Retry|Back off/);
  });

  it('carries the per-connection throughput trap into the throttling guidance', () => {
    // The same trap the capacity view had to get right: `throughput` is
    // enforced per connection, so parallel connections multiply the real rate.
    expect(decodeSmppStatus(0x00000058).guidance).toMatch(/PER CONNECTION/);
  });

  /**
   * The important negative case. SMPP reserves 0x400-0x4FF for vendor use, so
   * a carrier's code means whatever that carrier says. Mapping it onto a
   * plausible standard name would be an invented fact the operator then acts on.
   */
  it('never guesses a name for an unknown code', () => {
    const status = decodeSmppStatus(0x00000401);
    expect(status.name).toBe('0x00000401');
    expect(status.meaning).toMatch(/vendor-specific/i);
    expect(status.guidance).toMatch(/Only the carrier can say/);
  });

  it('does not claim the vendor range for a code outside it', () => {
    const status = decodeSmppStatus(0x00000777);
    expect(status.meaning).not.toMatch(/vendor-specific/i);
    expect(status.guidance).toMatch(/Do not assume it matches a similar standard code/);
  });

  it('renders an unknown code as padded hex, matching what carriers print', () => {
    expect(decodeSmppStatus(0x12).name).toBe('0x00000012');
  });

  it('treats an unknown status as not retryable', () => {
    // Retrying something we cannot interpret is a guess with a cost attached.
    expect(decodeSmppStatus(0x00000401).retryable).toBe(false);
  });

  it('separates transient refusals from permanent ones', () => {
    expect(decodeSmppStatus(0x00000058).retryable).toBe(true); // throttled
    expect(decodeSmppStatus(0x00000014).retryable).toBe(true); // queue full
    expect(decodeSmppStatus(0x0000000e).retryable).toBe(false); // bad password
    expect(decodeSmppStatus(0x0000000b).retryable).toBe(false); // bad destination
  });

  it('describes success without inventing an action for it', () => {
    const ok = decodeSmppStatus(0);
    expect(ok.name).toBe('ESME_ROK');
    expect(ok.guidance).toMatch(/No action needed/);
  });
});

describe('knownSmppStatuses', () => {
  it('covers materially more than the 13 bind-only codes it replaced', () => {
    expect(knownSmppStatuses().length).toBeGreaterThan(13);
  });

  it('includes the submit-path codes the old bind-only map lacked', () => {
    const names = knownSmppStatuses().map((status) => status.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ESME_RTHROTTLED',
        'ESME_RINVSRCADR',
        'ESME_RINVDSTADR',
        'ESME_RMSGQFUL',
        'ESME_RSUBMITFAIL',
      ]),
    );
  });

  it('is sorted by code, so a reference table reads predictably', () => {
    const codes = knownSmppStatuses().map((status) => status.code);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });
});
