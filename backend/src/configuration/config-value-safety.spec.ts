import {
  collectConfigValueProblems,
  describeConfigValueProblem,
  MAX_CONFIG_VALUE_LENGTH,
} from './config-value-safety';

/**
 * These guard against operator input that would corrupt — or in one case
 * permanently break — the generated engine configuration. The native validator
 * catches the same inputs before anything is written, so none of this is the
 * last line of defence; it exists so the operator learns WHICH FIELD is wrong,
 * at the moment they save it, instead of getting a bearerbox panic dump at
 * deploy time with no field named.
 */
describe('describeConfigValueProblem', () => {
  it('accepts the values real deployments actually use', () => {
    for (const value of [
      'smpp.carrier.example.net',
      '192.0.2.10',
      'carrier-primary',
      'JKANNEL',
      'https://sms.provider.example/submit?x=1',
      'GSM',
      '256,+256,00256',
    ])
      expect(describeConfigValueProblem('host', value)).toBeNull();
  });

  it('rejects a line break, naming directive injection as the consequence', () => {
    // Most directives are emitted unquoted, so everything after the break is
    // parsed as a fresh directive — the whole config, not just this field.
    const problem = describeConfigValueProblem('host', 'good.example.net\nsmsc-username = mallory');
    expect(problem?.reason).toMatch(/line break/);
    expect(problem?.reason).toMatch(/new configuration directive/);
  });

  it('rejects other control characters too', () => {
    // Built with fromCharCode so this source file stays plain text: a literal
    // control byte in a validator's own test is exactly the kind of thing that
    // should not be invisible in a diff.
    const withControl = 'a' + String.fromCharCode(1) + 'b';
    expect(describeConfigValueProblem('host', withControl)?.reason).toMatch(/control character/);
    expect(describeConfigValueProblem('host', 'a	b')?.reason).toMatch(/control character/);
  });

  it('rejects a double quote, which would close a quoted value early', () => {
    expect(describeConfigValueProblem('sendUrl', 'https://x/"')?.reason).toMatch(/double quote/);
  });

  it('rejects a backslash, the case that escapes its own closing quote', () => {
    // `abc\` renders as "abc\" — the engine unescapes \" and reads on.
    const problem = describeConfigValueProblem('sendUrl', 'https://x/path\\');
    expect(problem?.reason).toMatch(/backslash/);
  });

  it('rejects a leading # that would silently comment the directive out', () => {
    expect(describeConfigValueProblem('host', '#carrier.example')?.reason).toMatch(/comment/);
    expect(describeConfigValueProblem('host', '  #carrier.example')?.reason).toMatch(/comment/);
  });

  /**
   * The sharpest of the set. gwlib/cfg.c looks for include directives by
   * substring-searching the raw line rather than parsing the key, then lstat()s
   * the remainder and panics when that fails. The file is already on disk by
   * then, so every subsequent start panics too — a text field takes the gateway
   * down until someone edits the generated file by hand.
   */
  it('rejects any value containing "include", in any position or casing', () => {
    for (const value of ['includes.vendor.net', 'includeme', 'my-INCLUDE-host', 'x include y']) {
      const problem = describeConfigValueProblem('host', value);
      expect(problem).not.toBeNull();
      expect(problem?.reason).toMatch(/stop bearerbox from starting/);
    }
  });

  it('does not reject a value that merely resembles it', () => {
    expect(describeConfigValueProblem('host', 'inclusive.example.net')).toBeNull();
    expect(describeConfigValueProblem('host', 'includ.example.net')).toBeNull();
  });

  it('caps length', () => {
    expect(describeConfigValueProblem('host', 'a'.repeat(MAX_CONFIG_VALUE_LENGTH))).toBeNull();
    expect(
      describeConfigValueProblem('host', 'a'.repeat(MAX_CONFIG_VALUE_LENGTH + 1))?.reason,
    ).toMatch(/maximum/);
  });
});

describe('collectConfigValueProblems', () => {
  it('reports every offending field rather than stopping at the first', () => {
    // An operator fixing one field at a time through repeated 400s is a worse
    // experience than being told everything that is wrong at once.
    const problems = collectConfigValueProblems([
      ['host', 'includes.vendor.net'],
      ['systemType', 'ok'],
      ['sendUrl', 'https://x/\\'],
    ]);
    expect(problems.map((p) => p.field)).toEqual(['host', 'sendUrl']);
  });

  it('ignores absent and empty values, which are simply not rendered', () => {
    expect(
      collectConfigValueProblems([
        ['host', undefined],
        ['systemType', ''],
        ['addressRange', null],
        ['altCharset', 42],
      ]),
    ).toEqual([]);
  });
});
