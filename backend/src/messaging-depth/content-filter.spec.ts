import { BadRequestException } from '@nestjs/common';
import {
  CompiledContentRule,
  ContentFilterContext,
  ContentRuleRow,
  compareRules,
  compileRule,
  evaluateContent,
  explainContent,
  validatePattern,
} from './content-filter';

function row(overrides: Partial<ContentRuleRow> = {}): ContentRuleRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'rule',
    description: null,
    match_field: 'body',
    match_type: 'substring',
    pattern: 'loan',
    case_sensitive: false,
    action: 'block',
    smsc_id: null,
    customer_id: null,
    enabled: true,
    priority: 100,
    expires_at: null,
    reason: null,
    match_count: 0,
    last_matched_at: null,
    quarantined_at: null,
    quarantine_reason: null,
    created_by: 'u1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Compiles and sorts, exactly as ContentFilterService does at load. */
function ruleSet(...rows: Array<Partial<ContentRuleRow>>): CompiledContentRule[] {
  return rows.map((r, index) => compileRule(row({ id: id(index + 1), ...r }))).sort(compareRules);
}

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const message = (overrides: Partial<ContentFilterContext> = {}): ContentFilterContext => ({
  sender: 'JKANNEL',
  recipient: '256700000000',
  body: 'hello there',
  smscId: null,
  customerId: null,
  ...overrides,
});

describe('content filter — match types', () => {
  it('substring matches anywhere in the body, case-insensitively by default', () => {
    const rules = ruleSet({ match_type: 'substring', pattern: 'LOAN' });
    expect(evaluateContent(rules, message({ body: 'cheap loan today' })).allowed).toBe(false);
    expect(evaluateContent(rules, message({ body: 'nothing here' })).allowed).toBe(true);
  });

  it('honours case sensitivity when the operator asks for it', () => {
    const rules = ruleSet({ match_type: 'substring', pattern: 'LOAN', case_sensitive: true });
    expect(evaluateContent(rules, message({ body: 'cheap loan' })).allowed).toBe(true);
    expect(evaluateContent(rules, message({ body: 'cheap LOAN' })).allowed).toBe(false);
  });

  it('exact matches the whole subject and nothing less', () => {
    const rules = ruleSet({ match_field: 'sender', match_type: 'exact', pattern: 'SPAMCO' });
    expect(evaluateContent(rules, message({ sender: 'SPAMCO' })).allowed).toBe(false);
    expect(evaluateContent(rules, message({ sender: 'SPAMCO-2' })).allowed).toBe(true);
  });

  it('prefix matches the start of the subject', () => {
    const rules = ruleSet({ match_field: 'recipient', match_type: 'prefix', pattern: '25677' });
    expect(evaluateContent(rules, message({ recipient: '256771234567' })).allowed).toBe(false);
    expect(evaluateContent(rules, message({ recipient: '256701234567' })).allowed).toBe(true);
  });

  it('regex matches with the compiled, bounded pattern', () => {
    const rules = ruleSet({ match_type: 'regex', pattern: 'win \\d{3,6} now' });
    expect(evaluateContent(rules, message({ body: 'you WIN 5000 NOW' })).allowed).toBe(false);
    expect(evaluateContent(rules, message({ body: 'win now' })).allowed).toBe(true);
  });

  it('`any` tests body, then sender, then recipient, and says which one hit', () => {
    const rules = ruleSet({ match_field: 'any', match_type: 'substring', pattern: '9999' });
    expect(
      evaluateContent(rules, message({ body: 'x', sender: 'S9999' })).decidedBy?.matchedOn,
    ).toBe('sender');
    expect(
      evaluateContent(rules, message({ body: 'x', recipient: '2569999' })).decidedBy?.matchedOn,
    ).toBe('recipient');
    expect(evaluateContent(rules, message({ body: 'code 9999' })).decidedBy?.matchedOn).toBe(
      'body',
    );
  });

  it('never matches a rule whose stored regex will not compile, and never throws', () => {
    // Defence for a row that arrived by direct SQL or predates a validation
    // change: one corrupt rule must not take down a tenant's send path.
    const compiled = compileRule(row({ match_type: 'regex', pattern: '(unclosed' }));
    expect(compiled.compileError).toBeTruthy();
    expect(evaluateContent([compiled], message({ body: '(unclosed' })).allowed).toBe(true);
  });
});

describe('content filter — actions and precedence', () => {
  it('allows a message no rule matches, and says so', () => {
    const verdict = evaluateContent(ruleSet({ pattern: 'loan' }), message({ body: 'hi' }));
    expect(verdict).toMatchObject({ allowed: true, decidedBy: null });
    expect(verdict.reason).toContain('no content rule matched');
  });

  it('FIRST MATCH WINS: the lowest priority number decides, whatever its action', () => {
    // Allow first -> allowed, even though a block also matches.
    const allowFirst = ruleSet(
      { priority: 10, action: 'allow', pattern: 'loan', name: 'vip-exemption' },
      { priority: 20, action: 'block', pattern: 'loan', name: 'loan-block' },
    );
    const allowed = evaluateContent(allowFirst, message({ body: 'a loan offer' }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.decidedBy?.ruleName).toBe('vip-exemption');

    // Reverse the priorities and the SAME two rules produce the opposite policy.
    const blockFirst = ruleSet(
      { priority: 10, action: 'block', pattern: 'loan', name: 'loan-block' },
      { priority: 20, action: 'allow', pattern: 'loan', name: 'vip-exemption' },
    );
    const blocked = evaluateContent(blockFirst, message({ body: 'a loan offer' }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.decidedBy?.ruleName).toBe('loan-block');
  });

  it('stops at the first match: a later rule is never consulted', () => {
    const rules = ruleSet(
      { priority: 10, action: 'allow', pattern: 'loan' },
      { priority: 20, action: 'block', pattern: 'loan' },
      { priority: 30, action: 'block', pattern: 'loan' },
    );
    expect(evaluateContent(rules, message({ body: 'loan' })).rulesEvaluated).toBe(1);
  });

  it('breaks a priority tie by creation time — an older rule keeps its meaning', () => {
    const rules = ruleSet(
      {
        priority: 10,
        action: 'block',
        pattern: 'loan',
        name: 'older',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        priority: 10,
        action: 'allow',
        pattern: 'loan',
        name: 'newer',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    );
    expect(evaluateContent(rules, message({ body: 'loan' })).decidedBy?.ruleName).toBe('older');
  });

  it('breaks a same-instant tie by id, so the outcome is never row-order dependent', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const forwards = [
      compileRule(row({ id: id(1), name: 'a', action: 'block', created_at: same })),
      compileRule(row({ id: id(2), name: 'b', action: 'allow', created_at: same })),
    ];
    const backwards = [...forwards].reverse();
    expect(
      evaluateContent([...forwards].sort(compareRules), message({ body: 'loan' })).decidedBy
        ?.ruleName,
    ).toBe('a');
    expect(
      evaluateContent([...backwards].sort(compareRules), message({ body: 'loan' })).decidedBy
        ?.ruleName,
    ).toBe('a');
  });
});

describe('content filter — scope', () => {
  it('applies an SMSC-scoped rule only to traffic bound for that carrier', () => {
    const rules = ruleSet({ smsc_id: 'mtn-ug', pattern: 'promo' });
    expect(evaluateContent(rules, message({ body: 'promo', smscId: 'mtn-ug' })).allowed).toBe(
      false,
    );
    expect(evaluateContent(rules, message({ body: 'promo', smscId: 'airtel-ug' })).allowed).toBe(
      true,
    );
  });

  it('skips an SMSC-scoped rule entirely while the carrier is unknown', () => {
    // This is what makes the deferred evaluation point necessary rather than
    // optional: with smscId unknown the rule provably cannot be judged.
    const rules = ruleSet({ smsc_id: 'mtn-ug', pattern: 'promo' });
    const verdict = evaluateContent(rules, message({ body: 'promo', smscId: null }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.rulesEvaluated).toBe(0);
  });

  it('applies a customer-scoped rule only to that customer', () => {
    const rules = ruleSet({ customer_id: 'cust-a', pattern: 'promo' });
    expect(evaluateContent(rules, message({ body: 'promo', customerId: 'cust-a' })).allowed).toBe(
      false,
    );
    expect(evaluateContent(rules, message({ body: 'promo', customerId: 'cust-b' })).allowed).toBe(
      true,
    );
    expect(evaluateContent(rules, message({ body: 'promo', customerId: null })).allowed).toBe(true);
  });

  it('lets an SMSC-scoped allow pre-empt an unscoped block when it has priority', () => {
    const rules = ruleSet(
      { priority: 10, action: 'allow', smsc_id: 'mtn-ug', pattern: 'promo', name: 'mtn-ok' },
      { priority: 20, action: 'block', pattern: 'promo', name: 'no-promo' },
    );
    expect(
      evaluateContent(rules, message({ body: 'promo', smscId: 'mtn-ug' })).decidedBy?.ruleName,
    ).toBe('mtn-ok');
    expect(
      evaluateContent(rules, message({ body: 'promo', smscId: 'airtel-ug' })).decidedBy?.ruleName,
    ).toBe('no-promo');
  });
});

describe('content filter — explanation for the preview endpoint', () => {
  it('reports every matching rule and flags the ones a higher-precedence rule shadows', () => {
    const rules = ruleSet(
      { priority: 10, action: 'allow', pattern: 'loan', name: 'exempt' },
      { priority: 20, action: 'block', pattern: 'loan', name: 'shadowed-block' },
      { priority: 30, action: 'block', pattern: 'nothing-here', name: 'irrelevant' },
    );
    const explained = explainContent(rules, message({ body: 'loan offer' }));
    expect(explained.verdict.allowed).toBe(true);
    expect(explained.matches.map((m) => [m.ruleName, m.shadowed])).toEqual([
      ['exempt', false],
      ['shadowed-block', true],
    ]);
    expect(explained.inScope).toBe(3);
  });

  it('counts rules that are out of scope separately from rules that simply did not match', () => {
    const rules = ruleSet({ smsc_id: 'mtn-ug', pattern: 'loan' }, { pattern: 'nothing' });
    const explained = explainContent(rules, message({ body: 'loan', smscId: null }));
    expect(explained.skippedOutOfScope).toBe(1);
    expect(explained.inScope).toBe(1);
    expect(explained.matches).toHaveLength(0);
  });

  it('names the deciding rule in a sentence an operator can act on', () => {
    const rules = ruleSet({ pattern: 'loan', name: 'no-loans', reason: 'regulator directive' });
    const verdict = evaluateContent(rules, message({ body: 'loan' }));
    expect(verdict.reason).toContain('"no-loans"');
    expect(verdict.reason).toContain('substring match on body');
    expect(verdict.reason).toContain('regulator directive');
  });
});

describe('content filter — write-time pattern validation', () => {
  it('refuses an empty or whitespace-only literal pattern', () => {
    expect(() => validatePattern('substring', '')).toThrow(BadRequestException);
    expect(() => validatePattern('substring', '   ')).toThrow(BadRequestException);
  });

  it('refuses an unsafe regex before it can ever run on the send path', () => {
    expect(() => validatePattern('regex', '(a+)+$')).toThrow(BadRequestException);
    expect(validatePattern('regex', '^STOP$')).toBe('^STOP$');
  });

  it('accepts a long literal but caps it', () => {
    expect(validatePattern('substring', 'x'.repeat(512))).toHaveLength(512);
    expect(() => validatePattern('substring', 'x'.repeat(513))).toThrow(BadRequestException);
  });
});
