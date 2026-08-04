import { BadRequestException, PreconditionFailedException } from '@nestjs/common';
import { assertIfMatch, parseIfMatch, rowEtag, setEtagHeader, versionEtag } from './etag';

describe('versionEtag / rowEtag', () => {
  it('renders a strong entity tag for a version', () => {
    expect(versionEtag(7)).toBe('"7"');
    expect(rowEtag({ version: 0 })).toBe('"0"');
  });

  it('returns null for a row that carries no version', () => {
    expect(rowEtag({})).toBeNull();
    expect(rowEtag(null)).toBeNull();
    expect(rowEtag({ version: null })).toBeNull();
  });
});

describe('parseIfMatch', () => {
  it('returns undefined when the header is absent or blank', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('   ')).toBeUndefined();
  });

  it('parses a quoted version', () => {
    expect(parseIfMatch('"3"')).toBe(3);
  });

  it('accepts a weak tag on input', () => {
    expect(parseIfMatch('W/"3"')).toBe(3);
  });

  it('treats * as "any current version"', () => {
    expect(parseIfMatch('*')).toBeNull();
  });

  it('rejects a malformed tag rather than ignoring the precondition', () => {
    expect(() => parseIfMatch('"not-a-version"')).toThrow(BadRequestException);
    expect(() => parseIfMatch('"1", "2"')).toThrow(BadRequestException);
  });
});

describe('assertIfMatch', () => {
  it('is a no-op when no precondition was sent', () => {
    expect(assertIfMatch(undefined, { version: 4 })).toBeUndefined();
  });

  it('passes when the version matches', () => {
    expect(assertIfMatch('"4"', { version: 4 })).toBe(4);
  });

  it('412s when the row moved under the caller', () => {
    expect(() => assertIfMatch('"4"', { version: 5 }, 'Route')).toThrow(
      PreconditionFailedException,
    );
    expect(() => assertIfMatch('"4"', { version: 5 }, 'Route')).toThrow(
      /Route has version 5, not 4/,
    );
  });

  it('412s when the resource is gone', () => {
    expect(() => assertIfMatch('"4"', null)).toThrow(PreconditionFailedException);
  });

  it('400s rather than silently ignoring If-Match on an unversioned resource', () => {
    expect(() => assertIfMatch('"4"', { id: 'x' } as any)).toThrow(BadRequestException);
  });

  it('accepts * against any current version', () => {
    expect(assertIfMatch('*', { version: 11 })).toBe(11);
  });
});

describe('setEtagHeader', () => {
  it('sets the header for a versioned row', () => {
    const setHeader = jest.fn();
    setEtagHeader({ setHeader }, { version: 2 });
    expect(setHeader).toHaveBeenCalledWith('etag', '"2"');
  });

  it('sets nothing for an unversioned row', () => {
    const setHeader = jest.fn();
    setEtagHeader({ setHeader }, {});
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('tolerates a missing response object', () => {
    expect(() => setEtagHeader(undefined, { version: 1 })).not.toThrow();
  });
});
