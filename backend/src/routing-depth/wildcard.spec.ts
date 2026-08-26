import {
  MAX_ALTERNATIVES,
  MAX_PATTERN_LENGTH,
  compileWildcard,
  describeWildcard,
  describeWildcardProblem,
  isValidWildcard,
  matchesWildcard,
} from './wildcard';

describe('the grammar SMS Studio operators already know', () => {
  it('matches the document’s own example: all MTN Uganda MSISDNs', () => {
    const mtn = '25677*|25678*|25676*|25679*';
    for (const number of ['256772000118', '256781234567', '256760000001', '256790000001'])
      expect(matchesWildcard(number, mtn)).toBe(true);
    // Airtel Uganda prefixes must not match.
    for (const number of ['256700123456', '256752000000', '256414000000'])
      expect(matchesWildcard(number, mtn)).toBe(false);
  });

  it('* matches any run of characters, including none', () => {
    expect(matchesWildcard('anything at all', '*')).toBe(true);
    expect(matchesWildcard('', '*')).toBe(true);
    expect(matchesWildcard('25677', '25677*')).toBe(true);
    expect(matchesWildcard('otp code 4412', '*otp*')).toBe(true);
    expect(matchesWildcard('your pin', '*otp*')).toBe(false);
  });

  it('# matches exactly one digit', () => {
    expect(matchesWildcard('2567', '256#')).toBe(true);
    expect(matchesWildcard('256a', '256#')).toBe(false);
    // Exactly one — not zero, not two.
    expect(matchesWildcard('256', '256#')).toBe(false);
    expect(matchesWildcard('25677', '256#')).toBe(false);
  });

  it('$ matches exactly one letter', () => {
    expect(matchesWildcard('MTNa', 'MTN$')).toBe(true);
    expect(matchesWildcard('MTN1', 'MTN$')).toBe(false);
    expect(matchesWildcard('MTN', 'MTN$')).toBe(false);
  });

  it('| is alternation between whole patterns', () => {
    expect(matchesWildcard('otp 1234', '*otp*|*code*')).toBe(true);
    expect(matchesWildcard('your code', '*otp*|*code*')).toBe(true);
    expect(matchesWildcard('hello', '*otp*|*code*')).toBe(false);
  });

  it('combines the metacharacters in one alternative', () => {
    // "MTN" then three digits.
    expect(matchesWildcard('MTN256', 'MTN###')).toBe(true);
    expect(matchesWildcard('MTN25', 'MTN###')).toBe(false);
  });
});

describe('a pattern cannot become a regex by accident', () => {
  it('treats a dot as a literal dot', () => {
    // The commonest regex mistake, and the one that silently over-matches.
    expect(matchesWildcard('mtn.co.ug', 'mtn.co.ug')).toBe(true);
    expect(matchesWildcard('mtnXcoYug', 'mtn.co.ug')).toBe(false);
  });

  it('treats regex metacharacters as literals', () => {
    for (const [value, pattern] of [
      ['a+b', 'a+b'],
      ['a?b', 'a?b'],
      ['(group)', '(group)'],
      ['[set]', '[set]'],
      ['^caret', '^caret'],
      ['back\\slash', 'back\\slash'],
      ['{2,3}', '{2,3}'],
    ])
      expect(matchesWildcard(value, pattern)).toBe(true);
    expect(matchesWildcard('aab', 'a+b')).toBe(false);
  });

  it('cannot express catastrophic backtracking', () => {
    // In the `regex` match type this input hangs. Here it is a literal string,
    // which matters because content rules run inside every send transaction.
    const started = Date.now();
    expect(matchesWildcard('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', '(a+)+b')).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('anchors both ends, so a short pattern is not a substring match', () => {
    // Unanchored, `77` would match every number containing 77 — a silent
    // over-block. Use *77* when that is what you mean.
    expect(matchesWildcard('256772000118', '77')).toBe(false);
    expect(matchesWildcard('256772000118', '*77*')).toBe(true);
  });
});

describe('case sensitivity', () => {
  it('is insensitive by default, which is what a sender id needs', () => {
    expect(matchesWildcard('JKANNEL', 'jkannel')).toBe(true);
    expect(matchesWildcard('Otp code', '*otp*')).toBe(true);
  });

  it('is exact when the rule asks for it', () => {
    expect(matchesWildcard('JKANNEL', 'jkannel', true)).toBe(false);
    expect(matchesWildcard('JKANNEL', 'JKANNEL', true)).toBe(true);
  });
});

describe('an absent value never matches', () => {
  it('does not match even against *', () => {
    // `*` means "any value". A message with no sender has no value, and letting
    // it match would make an "all senders" rule quietly also catch messages
    // whose sender failed to parse.
    expect(matchesWildcard(null, '*')).toBe(false);
    expect(matchesWildcard(undefined, '*')).toBe(false);
    // An empty string IS a value, and does match.
    expect(matchesWildcard('', '*')).toBe(true);
  });
});

describe('an invalid pattern matches nothing', () => {
  it('fails closed rather than open', () => {
    // A broken block rule that blocks nothing is bad. One that blocks all
    // traffic is an outage.
    expect(matchesWildcard('anything', '')).toBe(false);
    expect(matchesWildcard('anything', 'a||b')).toBe(false);
  });
});

describe('describeWildcardProblem', () => {
  it('rejects an empty pattern and points at the alternative', () => {
    expect(describeWildcardProblem('   ')?.code).toBe('empty');
    expect(describeWildcardProblem('   ')?.message).toContain('Use * to match everything');
  });

  it('rejects an empty alternative, which would match everything', () => {
    expect(describeWildcardProblem('25677*|')?.code).toBe('empty-alternative');
    expect(describeWildcardProblem('|25677*')?.code).toBe('empty-alternative');
    expect(describeWildcardProblem('a||b')?.code).toBe('empty-alternative');
  });

  it('bounds length and alternative count, so one rule cannot dominate a send', () => {
    expect(describeWildcardProblem('a'.repeat(MAX_PATTERN_LENGTH + 1))?.code).toBe('too-long');
    expect(
      describeWildcardProblem(Array(MAX_ALTERNATIVES + 1).fill('a').join('|'))?.code,
    ).toBe('too-many-alternatives');
  });

  it('accepts the patterns the document uses', () => {
    for (const pattern of ['25677*|25678*|25676*|25679*', '*otp*|*code*', '***', '256#######'])
      expect(isValidWildcard(pattern)).toBe(true);
  });
});

describe('compileWildcard', () => {
  it('throws on an invalid pattern rather than compiling something surprising', () => {
    expect(() => compileWildcard('a||b')).toThrow(/empty alternative/i);
  });
});

describe('describeWildcard', () => {
  it('reads a pattern back in words, for a confirmation dialog', () => {
    // An operator approving a rule that drops traffic should not have to
    // mentally compile it first.
    expect(describeWildcard('*')).toBe('anything');
    expect(describeWildcard('25677*')).toBe('anything starting with "25677"');
    expect(describeWildcard('*4412')).toBe('anything ending with "4412"');
    expect(describeWildcard('JKANNEL')).toBe('exactly "JKANNEL"');
    expect(describeWildcard('25677*|25678*')).toBe(
      'anything starting with "25677" or anything starting with "25678"',
    );
  });

  it('does not pretend to summarise a pattern it cannot phrase', () => {
    expect(describeWildcard('256##*77')).toBe('the pattern "256##*77"');
  });
});

describe('spacing around the | separator', () => {
  /*
   * The readable way to write a long pattern is with spaces around the pipes,
   * and until this was fixed that silently disabled every branch but the first:
   * " 25678*" is an alternative starting with a literal space, which no MSISDN
   * has. Nothing reported a problem, because structurally there was none.
   */
  const SPACED = '25677* | 25678* | 25676* | 25679*';
  const TIGHT = '25677*|25678*|25676*|25679*';

  it('treats a spaced pattern exactly like a tight one', () => {
    for (const msisdn of ['256772123456', '256782123456', '256762123456', '256792123456']) {
      expect(matchesWildcard(msisdn, SPACED)).toBe(true);
      expect(matchesWildcard(msisdn, TIGHT)).toBe(true);
    }
  });

  it('still does not match a number outside the set', () => {
    // Guards the opposite failure: trimming must not widen the pattern.
    expect(matchesWildcard('256752123456', SPACED)).toBe(false);
    expect(matchesWildcard('256702123456', SPACED)).toBe(false);
  });

  it('reports a whitespace-only alternative rather than accepting it', () => {
    // "a|  |b" used to be three valid alternatives, the middle one matching a
    // pair of spaces. Trimmed, it is empty — and an empty alternative matches
    // everything, which is the one outcome that must never happen quietly.
    expect(describeWildcardProblem('25677*|   |25678*')?.code).toBe('empty-alternative');
  });

  it('keeps spaces INSIDE an alternative, which a sender id can have', () => {
    expect(matchesWildcard('MY BANK', 'MY BANK')).toBe(true);
    expect(matchesWildcard('MY BANK', 'MY B*')).toBe(true);
  });

  it('describes a spaced pattern without the stray spaces', () => {
    expect(describeWildcard(SPACED)).toBe(describeWildcard(TIGHT));
  });
});
