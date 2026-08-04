import { BadRequestException } from '@nestjs/common';
import { describeMessageFilters, parseInstant, parseMessageFilters } from './message-filters';

const limits = { defaultLimit: 100, maxLimit: 500 };
const parse = (q: any) => parseMessageFilters(q, limits);
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The message and the status of the 400 a bad filter must produce. */
function rejection(q: any): string {
  try {
    parse(q);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return String((error as BadRequestException).message);
  }
  throw new Error('expected the filter set to be rejected');
}

describe('date-range parsing', () => {
  it('accepts a full ISO 8601 instant and converts it to the engine epoch', () => {
    expect(parse({ from: '2026-08-04T09:00:00Z' }).fromEpoch).toBe(epoch('2026-08-04T09:00:00Z'));
    expect(parse({ to: '2026-08-04T10:00:00.500Z' }).toEpoch).toBe(
      epoch('2026-08-04T10:00:00.000Z'),
    );
  });

  it('accepts an offset and honours it', () => {
    expect(parse({ from: '2026-08-04T12:00:00+03:00' }).fromEpoch).toBe(
      epoch('2026-08-04T09:00:00Z'),
    );
  });

  it('reads a value with no offset as UTC, not as the server’s local zone', () => {
    // Otherwise the same request would mean different instants on two hosts.
    expect(parse({ from: '2026-08-04T09:00:00' }).fromEpoch).toBe(epoch('2026-08-04T09:00:00Z'));
    expect(parse({ from: '2026-08-04T09:00' }).fromEpoch).toBe(epoch('2026-08-04T09:00:00Z'));
  });

  it('accepts a date-only value as UTC midnight', () => {
    expect(parse({ from: '2026-08-04' }).fromEpoch).toBe(epoch('2026-08-04T00:00:00Z'));
  });

  it('leaves both bounds undefined when neither is supplied', () => {
    const filters = parse({});
    expect(filters.fromEpoch).toBeUndefined();
    expect(filters.toEpoch).toBeUndefined();
  });

  it.each(['', null, undefined])('treats %p as "no bound" rather than an error', (value) => {
    expect(parse({ from: value, to: value }).fromEpoch).toBeUndefined();
  });
});

describe('date ranges that cannot be honoured are 400s that name the problem', () => {
  it('rejects a non-ISO date', () => {
    expect(rejection({ from: '04/08/2026' })).toContain('from must be an ISO 8601 date-time');
    expect(rejection({ from: '04/08/2026' })).toContain('04/08/2026');
    expect(rejection({ to: 'yesterday' })).toContain('to must be an ISO 8601 date-time');
  });

  it('rejects loose input Date.parse would otherwise accept', () => {
    // Date.parse('March 3 2026') resolves happily; accepting it would make a
    // mistyped range look like it worked.
    expect(() => parse({ from: 'March 3 2026' })).toThrow(BadRequestException);
    expect(() => parse({ from: '2026/08/04' })).toThrow(BadRequestException);
  });

  it('rejects a date that is not on the calendar instead of rolling it over', () => {
    expect(rejection({ from: '2026-02-31' })).toContain('not a real calendar date');
    expect(rejection({ from: '2026-13-01' })).toContain('from');
  });

  it('rejects a non-string bound', () => {
    expect(rejection({ from: 12345 })).toContain('from must be an ISO 8601 date-time string');
  });

  it('rejects an INVERTED range and shows both ends', () => {
    const message = rejection({ from: '2026-08-04T10:00:00Z', to: '2026-08-04T09:00:00Z' });
    expect(message).toContain('from must not be after to');
    expect(message).toContain('2026-08-04T10:00:00Z');
    expect(message).toContain('2026-08-04T09:00:00Z');
  });

  it('allows a zero-width range (from === to)', () => {
    const filters = parse({ from: '2026-08-04T09:00:00Z', to: '2026-08-04T09:00:00Z' });
    expect(filters.fromEpoch).toBe(filters.toEpoch);
  });
});

describe('status filters are validated, never silently dropped', () => {
  it.each([
    'sent',
    'dlr',
    'delivery_report',
    'delivered',
    'failed',
    'rejected',
    'buffered',
    'accepted',
    'pending',
    'unknown',
    'resendable',
    'in-flight',
  ])('accepts %s', (token) => {
    expect(parse({ status: token }).status).toBe(token);
  });

  it('accepts a comma-separated expression and trims it', () => {
    expect(parse({ status: ' failed , rejected ' }).status).toBe('failed,rejected');
  });

  it('rejects a typo rather than returning every message', () => {
    const message = rejection({ status: 'faield' });
    expect(message).toContain('status contains unsupported value(s): faield');
  });

  it('validates deliveryStatus by the same vocabulary', () => {
    expect(parse({ deliveryStatus: 'delivered' }).deliveryStatus).toBe('delivered');
    expect(rejection({ deliveryStatus: 'nope' })).toContain('deliveryStatus contains unsupported');
  });
});

describe('the remaining grid filters', () => {
  it('normalises direction and rejects anything else', () => {
    expect(parse({ direction: 'mt' }).direction).toBe('MT');
    expect(parse({ direction: 'DLR' }).direction).toBe('DLR');
    expect(rejection({ direction: 'sideways' })).toContain('direction must be one of MO, MT, DLR');
  });

  it('bounds the limit and defaults it', () => {
    expect(parse({}).limit).toBe(100);
    expect(parse({ limit: '250' }).limit).toBe(250);
    expect(rejection({ limit: '501' })).toContain('limit must be an integer between 1 and 500');
    expect(rejection({ limit: '0' })).toContain('limit');
    expect(rejection({ limit: '1.5' })).toContain('limit');
  });

  it('trims the free-text query and the smscId', () => {
    expect(parse({ query: '  256700  ', smscId: ' carrier-a ' })).toMatchObject({
      query: '256700',
      smscId: 'carrier-a',
    });
  });

  it('carries the cursor through as an integer', () => {
    expect(parse({ cursor: '4200' }).cursor).toBe(4200);
    expect(parse({}).cursor).toBeUndefined();
  });
});

describe('parseInstant', () => {
  it('floors to whole epoch seconds', () => {
    expect(parseInstant('1970-01-01T00:00:00.999Z', 'from')).toBe(0);
  });
});

describe('describeMessageFilters', () => {
  it('renders every applied filter, and nothing when none are', () => {
    expect(describeMessageFilters(parse({}))).toBeUndefined();
    const description = describeMessageFilters(
      parse({
        query: 'abc',
        smscId: 'carrier-a',
        direction: 'MT',
        status: 'failed',
        from: '2026-08-04T09:00:00Z',
        to: '2026-08-04T10:00:00Z',
      }),
    );
    expect(description).toContain('query="abc"');
    expect(description).toContain('smscId=carrier-a');
    expect(description).toContain('direction=MT');
    expect(description).toContain('status=failed');
    expect(description).toContain('from=2026-08-04T09:00:00.000Z');
    expect(description).toContain('to=2026-08-04T10:00:00.000Z');
  });
});
