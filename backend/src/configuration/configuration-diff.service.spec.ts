import { ConfigurationDiffService } from './configuration-diff.service';
describe('ConfigurationDiffService', () => {
  it('classifies deterministic line differences', () => {
    expect(new ConfigurationDiffService().compare('a\nb\n', 'a\nc\nd\n')).toEqual(
      expect.arrayContaining([
        { line: 2, kind: 'changed', before: 'b', after: 'c' },
        { line: 3, kind: 'changed', before: '', after: 'd' },
      ]),
    );
  });
});
