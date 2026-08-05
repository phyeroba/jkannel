import { BadRequestException } from '@nestjs/common';
import {
  CompiledMoRule,
  MoDestinationRow,
  MoMessageContext,
  MoRuleRow,
  canonicalAddress,
  compareMoRules,
  compileMoRule,
  firstWord,
  isPrivateHost,
  matchMoRules,
  validateDestinationTarget,
} from './mo-routing';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function ruleRow(overrides: Partial<MoRuleRow> = {}): MoRuleRow {
  return {
    id: id(1),
    name: 'rule',
    description: null,
    enabled: true,
    priority: 100,
    match_smsc_id: null,
    match_destination: null,
    match_destination_type: 'any',
    match_sender_prefix: null,
    match_keyword: null,
    match_keyword_type: 'any',
    case_sensitive: false,
    continue_after_match: false,
    customer_id: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function destination(ruleId: string, n: number): MoDestinationRow {
  return {
    id: id(100 + n),
    rule_id: ruleId,
    kind: 'webhook',
    target: `https://example.com/${n}`,
    enabled: true,
    config: {},
    max_attempts: 5,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function ruleSet(
  rows: Array<Partial<MoRuleRow>>,
  destinations: MoDestinationRow[] = [],
): CompiledMoRule[] {
  return rows
    .map((r, index) => compileMoRule(ruleRow({ id: id(index + 1), ...r }), destinations))
    .sort(compareMoRules);
}

const inbound = (overrides: Partial<MoMessageContext> = {}): MoMessageContext => ({
  smscId: 'mtn-ug',
  sender: '+256700123456',
  receiver: '8080',
  body: 'BAL please',
  ...overrides,
});

describe('MO routing — matching criteria', () => {
  it('a rule with no criteria is a catch-all', () => {
    expect(matchMoRules(ruleSet([{}]), inbound()).matches).toHaveLength(1);
  });

  it('matches on the receiving SMSC', () => {
    const rules = ruleSet([{ match_smsc_id: 'mtn-ug' }]);
    expect(matchMoRules(rules, inbound({ smscId: 'mtn-ug' })).matches).toHaveLength(1);
    expect(matchMoRules(rules, inbound({ smscId: 'airtel-ug' })).matches).toHaveLength(0);
  });

  it('matches a short code exactly, and a long number by prefix', () => {
    const exact = ruleSet([{ match_destination: '8080', match_destination_type: 'exact' }]);
    expect(matchMoRules(exact, inbound({ receiver: '8080' })).matches).toHaveLength(1);
    expect(matchMoRules(exact, inbound({ receiver: '80801' })).matches).toHaveLength(0);

    const prefix = ruleSet([{ match_destination: '25677', match_destination_type: 'prefix' }]);
    expect(matchMoRules(prefix, inbound({ receiver: '+256772222222' })).matches).toHaveLength(1);
    expect(matchMoRules(prefix, inbound({ receiver: '+256702222222' })).matches).toHaveLength(0);
  });

  it('matches a sender prefix against the CANONICAL digits, however the engine formatted it', () => {
    const rules = ruleSet([{ match_sender_prefix: '256700' }]);
    for (const sender of ['+256700123456', '00256700123456', '256 700 123 456'])
      expect(matchMoRules(rules, inbound({ sender })).matches).toHaveLength(1);
    expect(matchMoRules(rules, inbound({ sender: '+256711123456' })).matches).toHaveLength(0);
  });

  it('matches a keyword as the first word, a substring, or the whole body', () => {
    const first = ruleSet([{ match_keyword: 'BAL', match_keyword_type: 'first_word' }]);
    expect(matchMoRules(first, inbound({ body: 'bal please' })).matches).toHaveLength(1);
    expect(matchMoRules(first, inbound({ body: 'my bal please' })).matches).toHaveLength(0);

    const substring = ruleSet([{ match_keyword: 'BAL', match_keyword_type: 'substring' }]);
    expect(matchMoRules(substring, inbound({ body: 'my bal please' })).matches).toHaveLength(1);

    const exact = ruleSet([{ match_keyword: 'STOP', match_keyword_type: 'exact' }]);
    expect(matchMoRules(exact, inbound({ body: '  stop ' })).matches).toHaveLength(1);
    expect(matchMoRules(exact, inbound({ body: 'stop now' })).matches).toHaveLength(0);
  });

  it('honours case sensitivity on keywords when asked', () => {
    const rules = ruleSet([
      { match_keyword: 'STOP', match_keyword_type: 'first_word', case_sensitive: true },
    ]);
    expect(matchMoRules(rules, inbound({ body: 'stop' })).matches).toHaveLength(0);
    expect(matchMoRules(rules, inbound({ body: 'STOP' })).matches).toHaveLength(1);
  });

  it('ANDs the criteria: every one supplied must hold', () => {
    const rules = ruleSet([
      {
        match_smsc_id: 'mtn-ug',
        match_destination: '8080',
        match_destination_type: 'exact',
        match_keyword: 'BAL',
        match_keyword_type: 'first_word',
      },
    ]);
    expect(matchMoRules(rules, inbound()).matches).toHaveLength(1);
    expect(matchMoRules(rules, inbound({ smscId: 'airtel-ug' })).matches).toHaveLength(0);
    expect(matchMoRules(rules, inbound({ body: 'TOPUP' })).matches).toHaveLength(0);
  });

  it('records which criteria constrained the match, for the audit trail', () => {
    const rules = ruleSet([
      { match_smsc_id: 'mtn-ug', match_keyword: 'BAL', match_keyword_type: 'first_word' },
    ]);
    expect(matchMoRules(rules, inbound()).matches[0].matchedOn).toEqual([
      'smsc=mtn-ug',
      'keyword first_word "BAL"',
    ]);
  });
});

describe('MO routing — precedence', () => {
  it('first match wins and matching stops', () => {
    const rules = ruleSet([
      {
        priority: 10,
        name: 'stop-handler',
        match_keyword: 'STOP',
        match_keyword_type: 'first_word',
      },
      { priority: 20, name: 'catch-all' },
    ]);
    const result = matchMoRules(rules, inbound({ body: 'STOP' }));
    expect(result.matches.map((m) => m.ruleName)).toEqual(['stop-handler']);
    expect(result.stoppedEarly).toBe(true);
  });

  it('a non-terminal rule lets a later rule ALSO deliver the same message', () => {
    const rules = ruleSet([
      { priority: 10, name: 'audit-everything', continue_after_match: true },
      { priority: 20, name: 'crm' },
    ]);
    expect(matchMoRules(rules, inbound()).matches.map((m) => m.ruleName)).toEqual([
      'audit-everything',
      'crm',
    ]);
  });

  it('orders by priority, then age, then id — never by row order', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const rows = [
      ruleRow({ id: id(2), name: 'b', priority: 10, created_at: same }),
      ruleRow({ id: id(1), name: 'a', priority: 10, created_at: same }),
    ].map((r) => compileMoRule(r, []));
    expect([...rows].sort(compareMoRules).map((r) => r.name)).toEqual(['a', 'b']);
    expect(
      [...rows]
        .reverse()
        .sort(compareMoRules)
        .map((r) => r.name),
    ).toEqual(['a', 'b']);
  });

  it('attaches only the ENABLED destinations of its own rule', () => {
    const destinations = [
      destination(id(1), 1),
      { ...destination(id(1), 2), enabled: false },
      destination(id(2), 3),
    ];
    const compiled = compileMoRule(ruleRow({ id: id(1) }), destinations);
    expect(compiled.destinations.map((d) => d.target)).toEqual(['https://example.com/1']);
  });
});

describe('MO routing — address canonicalisation', () => {
  it('normalises a subscriber MSISDN to E.164 digits', () => {
    expect(canonicalAddress('+256 700 123 456')).toBe('256700123456');
    expect(canonicalAddress('00256700123456')).toBe('256700123456');
  });

  it('keeps a short code usable instead of rejecting it as a bad MSISDN', () => {
    // A short code is too short to be E.164; refusing it would make MO routing
    // useless for exactly the traffic it is mostly about.
    expect(canonicalAddress('8080')).toBe('8080');
  });

  it('falls back to case-folded text for an alphanumeric originator', () => {
    expect(canonicalAddress('MyBank')).toBe('mybank');
  });

  it('firstWord handles padding and empty bodies', () => {
    expect(firstWord('  STOP now ')).toBe('STOP');
    expect(firstWord('')).toBe('');
  });
});

describe('MO routing — destination validation', () => {
  afterEach(() => {
    delete process.env.MO_WEBHOOK_ALLOW_PRIVATE;
  });

  it('accepts a public https webhook and normalises it', () => {
    expect(validateDestinationTarget('webhook', 'https://hooks.example.com/mo')).toBe(
      'https://hooks.example.com/mo',
    );
  });

  it('refuses a webhook pointing at loopback, private space or cloud metadata', () => {
    for (const target of [
      'http://localhost:3000/hook',
      'http://127.0.0.1/hook',
      'http://10.1.2.3/hook',
      'http://192.168.0.5/hook',
      'http://172.20.0.1/hook',
      'http://169.254.169.254/latest/meta-data/',
    ])
      expect(() => validateDestinationTarget('webhook', target)).toThrow(BadRequestException);
  });

  it('allows an internal webhook only when the deployment opts in explicitly', () => {
    process.env.MO_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(validateDestinationTarget('webhook', 'http://10.1.2.3/hook')).toContain('10.1.2.3');
  });

  it('refuses a non-http scheme', () => {
    expect(() => validateDestinationTarget('webhook', 'file:///etc/passwd')).toThrow(
      BadRequestException,
    );
    expect(() => validateDestinationTarget('webhook', 'not a url')).toThrow(BadRequestException);
  });

  it('validates email and SMS targets for their kind', () => {
    expect(validateDestinationTarget('email', 'ops@example.com')).toBe('ops@example.com');
    expect(() => validateDestinationTarget('email', 'not-an-email')).toThrow(BadRequestException);
    expect(validateDestinationTarget('sms', '+256 700 123 456')).toBe('256700123456');
    expect(() => validateDestinationTarget('sms', 'abc')).toThrow(BadRequestException);
  });

  it('classifies hosts correctly', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('api.local')).toBe(true);
  });
});
