import { isIpAllowed, parseIp } from './ip-allowlist';

describe('isIpAllowed', () => {
  it('allows all when the allowlist is empty or absent', () => {
    expect(isIpAllowed('203.0.113.5', [])).toBe(true);
    expect(isIpAllowed('203.0.113.5', undefined)).toBe(true);
    expect(isIpAllowed('203.0.113.5', null)).toBe(true);
    // Whitespace-only entries are ignored, so this is still "allow all".
    expect(isIpAllowed('203.0.113.5', ['  '])).toBe(true);
    // With no caller IP but an empty list, still allowed.
    expect(isIpAllowed(undefined, [])).toBe(true);
  });

  it('matches an exact IPv4 address and rejects others', () => {
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true);
    expect(isIpAllowed('203.0.113.6', ['203.0.113.5'])).toBe(false);
  });

  it('matches inside an IPv4 CIDR block and rejects outside it', () => {
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('192.168.1.20', ['192.168.1.0/24'])).toBe(true);
    expect(isIpAllowed('192.168.2.20', ['192.168.1.0/24'])).toBe(false);
  });

  it('treats /0 as match-all and /32 as an exact host', () => {
    expect(isIpAllowed('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5/32'])).toBe(true);
    expect(isIpAllowed('203.0.113.6', ['203.0.113.5/32'])).toBe(false);
  });

  it('accepts a match against any entry in a multi-entry list', () => {
    const list = ['192.168.0.0/16', '203.0.113.5'];
    expect(isIpAllowed('192.168.44.9', list)).toBe(true);
    expect(isIpAllowed('203.0.113.5', list)).toBe(true);
    expect(isIpAllowed('8.8.8.8', list)).toBe(false);
  });

  it('denies when a non-empty allowlist has no caller IP or an unparseable one', () => {
    expect(isIpAllowed(undefined, ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('not-an-ip', ['10.0.0.0/8'])).toBe(false);
  });

  it('does not cross-match IPv4 against IPv6 families', () => {
    expect(isIpAllowed('::1', ['10.0.0.0/8'])).toBe(false);
    expect(isIpAllowed('10.0.0.1', ['2001:db8::/32'])).toBe(false);
  });

  it('matches IPv6 exact and CIDR', () => {
    expect(isIpAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(isIpAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(isIpAllowed('::1', ['::1'])).toBe(true);
  });

  it('ignores an unparseable allowlist entry rather than throwing', () => {
    expect(isIpAllowed('10.0.0.1', ['garbage/xx', '10.0.0.0/8'])).toBe(true);
    expect(isIpAllowed('10.0.0.1', ['garbage'])).toBe(false);
  });
});

describe('parseIp', () => {
  it('parses IPv4 and reports 32-bit width', () => {
    expect(parseIp('1.2.3.4')).toEqual({ value: 0x01020304n, bits: 32 });
  });
  it('rejects out-of-range octets and malformed input', () => {
    expect(parseIp('256.0.0.1')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('')).toBeNull();
  });
  it('parses compressed IPv6 to 128-bit width', () => {
    const parsed = parseIp('::1');
    expect(parsed?.bits).toBe(128);
    expect(parsed?.value).toBe(1n);
  });
});
