import { parseSentinels } from './redis-options';

describe('parseSentinels', () => {
  it('returns an empty list for unset/blank input', () => {
    expect(parseSentinels(undefined)).toEqual([]);
    expect(parseSentinels('')).toEqual([]);
    expect(parseSentinels('   ')).toEqual([]);
  });

  it('parses a comma-separated host:port list', () => {
    expect(parseSentinels('sentinel-1:26379, sentinel-2:26380')).toEqual([
      { host: 'sentinel-1', port: 26379 },
      { host: 'sentinel-2', port: 26380 },
    ]);
  });

  it('defaults a bare host to the standard sentinel port', () => {
    expect(parseSentinels('sentinel-1')).toEqual([{ host: 'sentinel-1', port: 26379 }]);
  });

  it('defaults a non-numeric port to 26379', () => {
    expect(parseSentinels('sentinel-1:abc')).toEqual([{ host: 'sentinel-1', port: 26379 }]);
  });

  it('ignores empty entries from trailing/duplicate commas', () => {
    expect(parseSentinels('a:1,,b:2,')).toEqual([
      { host: 'a', port: 1 },
      { host: 'b', port: 2 },
    ]);
  });
});
