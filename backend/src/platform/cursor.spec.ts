import { BadRequestException } from '@nestjs/common';
import { GridDefinition } from './list-query';
import {
  buildCursorPage,
  buildCursorSql,
  decodeCursor,
  encodeCursor,
  parseCursorQuery,
  usesCursor,
} from './cursor';

const grid: GridDefinition = {
  searchColumns: ['name'],
  sortColumns: { name: 'name', createdAt: 'created_at' },
  filterColumns: { enabled: 'enabled' },
  defaultOrderBy: 'created_at DESC',
};

describe('cursor encode/decode', () => {
  it('round-trips a payload through base64url', () => {
    const encoded = encodeCursor({ v: '2026-01-01T00:00:00Z', i: 'abc' });
    expect(encoded).not.toContain('=');
    expect(decodeCursor(encoded)).toEqual({ v: '2026-01-01T00:00:00Z', i: 'abc' });
  });

  it('supports numeric, boolean and null sort values', () => {
    expect(decodeCursor(encodeCursor({ v: 42, i: 'x' }))).toEqual({ v: 42, i: 'x' });
    expect(decodeCursor(encodeCursor({ v: true, i: 'x' }))).toEqual({ v: true, i: 'x' });
    expect(decodeCursor(encodeCursor({ v: null, i: 'x' }))).toEqual({ v: null, i: 'x' });
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeCursor('%%%not-base64%%%')).toThrow(BadRequestException);
    expect(() => decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toThrow(
      BadRequestException,
    );
    expect(() => decodeCursor(Buffer.from('{"i":"x"}', 'utf8').toString('base64url'))).toThrow(
      BadRequestException,
    );
    expect(() => decodeCursor(Buffer.from('{"v":"a"}', 'utf8').toString('base64url'))).toThrow(
      BadRequestException,
    );
  });
});

describe('parseCursorQuery', () => {
  it('detects opt-in via ?cursor or ?paginate=cursor', () => {
    expect(usesCursor({})).toBe(false);
    expect(usesCursor({ cursor: 'x' })).toBe(true);
    expect(usesCursor({ paginate: 'cursor' })).toBe(true);
  });

  it('defaults to the configured sort field and direction', () => {
    const parsed = parseCursorQuery(
      {},
      { grid, defaultSortField: 'createdAt', defaultDirection: 'DESC' },
    );
    expect(parsed).toMatchObject({ field: 'createdAt', sqlExpr: 'created_at', direction: 'DESC' });
    expect(parsed.limit).toBe(50);
    expect(parsed.after).toBeUndefined();
  });

  it('honours a whitelisted ?sort token and decodes ?cursor', () => {
    const cursor = encodeCursor({ v: 'Zeta', i: 'id-9' });
    const parsed = parseCursorQuery(
      { sort: '-name', limit: '10', cursor },
      { grid, defaultSortField: 'createdAt' },
    );
    expect(parsed).toMatchObject({ field: 'name', sqlExpr: 'name', direction: 'DESC', limit: 10 });
    expect(parsed.after).toEqual({ v: 'Zeta', i: 'id-9' });
  });

  it('rejects a non-whitelisted sort field', () => {
    expect(() =>
      parseCursorQuery({ sort: 'password' }, { grid, defaultSortField: 'createdAt' }),
    ).toThrow(BadRequestException);
  });
});

describe('buildCursorSql keyset ordering', () => {
  it('has no keyset predicate on the first page and over-fetches by one', () => {
    const parsed = parseCursorQuery(
      { limit: '3' },
      { grid, defaultSortField: 'createdAt', defaultDirection: 'DESC' },
    );
    const sql = buildCursorSql(parsed, 'id', ['tenant-1']);
    expect(sql.andWhere).toBe('');
    expect(sql.orderBy).toBe('ORDER BY created_at DESC, id DESC');
    expect(sql.limit).toBe('LIMIT $2');
    expect(sql.fetchLimit).toBe(4);
    expect(sql.params).toEqual(['tenant-1', 4]);
  });

  it('builds the ASC keyset predicate resolving ties by id', () => {
    const cursor = encodeCursor({ v: 'Acme', i: 'id-5' });
    const parsed = parseCursorQuery(
      { sort: 'name', limit: '2', cursor },
      { grid, defaultSortField: 'name' },
    );
    const sql = buildCursorSql(parsed, 'id', []);
    expect(sql.andWhere).toBe(' AND (name > $1 OR (name = $1 AND id > $2))');
    expect(sql.orderBy).toBe('ORDER BY name ASC, id ASC');
    expect(sql.params).toEqual(['Acme', 'id-5', 3]);
  });

  it('flips the comparison operator for DESC', () => {
    const cursor = encodeCursor({ v: 100, i: 'id-2' });
    const parsed = parseCursorQuery(
      { sort: '-createdAt', cursor },
      { grid, defaultSortField: 'createdAt' },
    );
    const sql = buildCursorSql(parsed, 'id', []);
    expect(sql.andWhere).toBe(' AND (created_at < $1 OR (created_at = $1 AND id < $2))');
  });
});

describe('buildCursorPage', () => {
  const select = {
    sortVal: (row: { created_at: string; id: string }) => row.created_at,
    id: (row: { id: string }) => row.id,
  };

  it('emits a nextCursor from the last kept row when more rows exist', () => {
    const parsed = parseCursorQuery({ limit: '2' }, { grid, defaultSortField: 'createdAt' });
    const rows = [
      { id: 'a', created_at: 't1' },
      { id: 'b', created_at: 't2' },
      { id: 'c', created_at: 't3' }, // over-fetched sentinel
    ];
    const page = buildCursorPage(rows, parsed, select);
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.limit).toBe(2);
    expect(decodeCursor(page.nextCursor as string)).toEqual({ v: 't2', i: 'b' });
  });

  it('returns nextCursor null on the last page', () => {
    const parsed = parseCursorQuery({ limit: '5' }, { grid, defaultSortField: 'createdAt' });
    const rows = [
      { id: 'a', created_at: 't1' },
      { id: 'b', created_at: 't2' },
    ];
    const page = buildCursorPage(rows, parsed, select);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('keyset boundary from one page excludes already-seen rows on the next query', () => {
    // Page 1
    const p1 = parseCursorQuery({ sort: 'name', limit: '2' }, { grid, defaultSortField: 'name' });
    const page1 = buildCursorPage(
      [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gamma' },
      ],
      p1,
      { sortVal: (r: { name: string }) => r.name, id: (r: { id: string }) => r.id },
    );
    // Page 2 built from the emitted cursor keys the WHERE past 'Beta'/'b'.
    const p2 = parseCursorQuery(
      { sort: 'name', limit: '2', cursor: page1.nextCursor as string },
      { grid, defaultSortField: 'name' },
    );
    const sql = buildCursorSql(p2, 'id', []);
    expect(p2.after).toEqual({ v: 'Beta', i: 'b' });
    expect(sql.params).toEqual(['Beta', 'b', 3]);
  });
});
