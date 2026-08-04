import { BadRequestException } from '@nestjs/common';
import { decodeCursor } from './cursor';
import { defaultSelectableFields, runGrid } from './grid-runner';
import { GridDefinition } from './list-query';

const GRID: GridDefinition = {
  searchColumns: ['label', 'detail'],
  sortColumns: { startedAt: 'started_at', label: 'label', status: 'status' },
  filterColumns: { status: 'status', kind: 'kind' },
  defaultOrderBy: 'started_at DESC',
  maxLimit: 200,
  defaultLimit: 25,
};

const SOURCE = { select: 'SELECT id,label,status,kind,started_at,detail', from: 'FROM backups' };

/** Captures the SQL and params the runner produced, and replays fixed rows. */
function recorder(rows: any[] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const execute = (async (sql: string, params: unknown[]) => {
    seen.push({ sql, params });
    return rows;
  }) as any;
  return { seen, execute };
}

describe('defaultSelectableFields', () => {
  it('infers row keys from the grid SQL expressions, not the API field names', () => {
    // sortColumns maps startedAt -> started_at; the projection runs on row keys.
    expect(defaultSelectableFields(GRID).sort()).toEqual(
      ['detail', 'id', 'kind', 'label', 'started_at', 'status'].sort(),
    );
  });

  it('strips table aliases so an aliased grid still projects', () => {
    expect(
      defaultSelectableFields({
        searchColumns: ['b.label'],
        sortColumns: { createdAt: 'b.created_at' },
        filterColumns: {},
        defaultOrderBy: 'b.created_at DESC',
      }),
    ).toEqual(expect.arrayContaining(['id', 'label', 'created_at']));
  });
});

describe('runGrid — offset mode (the existing contract, unchanged)', () => {
  it('returns items, total, limit and offset', async () => {
    const { seen, execute } = recorder([
      { id: 'a', label: 'nightly', status: 'completed', __total: '7' },
    ]);
    const page = await runGrid(SOURCE, GRID, {}, execute);
    expect(page.pagination).toBe('offset');
    expect(page.total).toBe(7);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).not.toHaveProperty('__total');
    expect(seen[0].sql).toContain('count(*) OVER() AS __total');
    expect(seen[0].sql).toContain('ORDER BY started_at DESC');
  });

  it('applies whitelisted search and filters as bind parameters', async () => {
    const { seen, execute } = recorder([]);
    await runGrid(SOURCE, GRID, { search: 'night', 'filter.status': 'failed' }, execute);
    expect(seen[0].sql).toContain('ILIKE');
    expect(seen[0].params).toEqual(expect.arrayContaining(['%night%', 'failed']));
  });

  it('rejects an unknown filter field', async () => {
    const { execute } = recorder([]);
    await expect(runGrid(SOURCE, GRID, { 'filter.secret': 'x' }, execute)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('honours a fixed WHERE clause and its existing bind parameters', async () => {
    const { seen, execute } = recorder([]);
    await runGrid(
      { ...SOURCE, where: 'WHERE tenant_id=$1', params: ['tenant-9'] },
      GRID,
      { 'filter.kind': 'full' },
      execute,
    );
    expect(seen[0].sql).toContain('WHERE tenant_id=$1');
    expect(seen[0].params[0]).toBe('tenant-9');
    expect(seen[0].params).toContain('full');
  });
});

describe('runGrid — ?fields= projection', () => {
  it('trims every row to the requested fields', async () => {
    const { execute } = recorder([
      { id: 'a', label: 'nightly', status: 'completed', kind: 'full', __total: '1' },
    ]);
    const page = await runGrid(SOURCE, GRID, { fields: 'id,label' }, execute);
    expect(page.items[0]).toEqual({ id: 'a', label: 'nightly' });
  });

  it('rejects an unknown field rather than silently returning everything', async () => {
    const { execute } = recorder([]);
    await expect(runGrid(SOURCE, GRID, { fields: 'id,password' }, execute)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns full objects when no projection is requested', async () => {
    const { execute } = recorder([{ id: 'a', label: 'nightly', __total: '1' }]);
    const page = await runGrid(SOURCE, GRID, {}, execute);
    expect(page.items[0]).toEqual({ id: 'a', label: 'nightly' });
  });

  it('honours an explicit selectableFields whitelist', async () => {
    const { execute } = recorder([{ id: 'a', secret: 's', __total: '1' }]);
    await expect(
      runGrid(SOURCE, GRID, { fields: 'secret' }, execute, { selectableFields: ['id'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('runGrid — cursor mode', () => {
  it('is a 400, not a silent fallback, on a grid that has not opted in', async () => {
    const { execute } = recorder([]);
    await expect(runGrid(SOURCE, GRID, { paginate: 'cursor' }, execute)).rejects.toThrow(
      /Cursor pagination is not available/,
    );
  });

  it('over-fetches one row and returns a nextCursor when more remain', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `id-${index}`,
      label: `row-${index}`,
      __cursor_sort: `2026-01-0${index + 1}T00:00:00.000Z`,
      __cursor_id: `id-${index}`,
    }));
    const { seen, execute } = recorder(rows);
    const page = await runGrid(SOURCE, GRID, { paginate: 'cursor', limit: 2 }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt', direction: 'ASC' },
    });

    expect(page.pagination).toBe('cursor');
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeNull();
    expect(page.offset).toBeNull();
    expect(seen[0].params[seen[0].params.length - 1]).toBe(3); // limit + 1
    expect(seen[0].sql).toContain('AS __cursor_sort');
    expect(seen[0].sql).toContain('ORDER BY started_at ASC, id ASC');
    // The cursor points at the LAST RETURNED row, not the over-fetched one.
    expect(decodeCursor(page.nextCursor!)).toEqual({
      v: '2026-01-02T00:00:00.000Z',
      i: 'id-1',
    });
    // The internal aliases never leak to the client.
    expect(page.items[0]).not.toHaveProperty('__cursor_sort');
    expect(page.items[0]).not.toHaveProperty('__cursor_id');
  });

  it('returns a null nextCursor on the last page', async () => {
    const { execute } = recorder([
      { id: 'a', __cursor_sort: '2026-01-01T00:00:00.000Z', __cursor_id: 'a' },
    ]);
    const page = await runGrid(SOURCE, GRID, { paginate: 'cursor', limit: 5 }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt' },
    });
    expect(page.nextCursor).toBeNull();
  });

  it('applies the keyset predicate when continuing from a cursor', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: '2026-01-02T00:00:00.000Z', i: 'id-1' }),
    ).toString('base64url');
    const { seen, execute } = recorder([]);
    await runGrid(SOURCE, GRID, { cursor, sort: '-startedAt' }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt' },
    });
    expect(seen[0].sql).toContain('started_at <');
    expect(seen[0].params).toEqual(expect.arrayContaining(['2026-01-02T00:00:00.000Z', 'id-1']));
  });

  it('filters a cursor page exactly as it filters an offset page', async () => {
    const { seen, execute } = recorder([]);
    await runGrid(SOURCE, GRID, { paginate: 'cursor', 'filter.status': 'failed' }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt' },
    });
    expect(seen[0].params).toContain('failed');
    expect(seen[0].sql).not.toContain('OFFSET');
  });

  it('serialises a Date sort value into the cursor', async () => {
    const { execute } = recorder([
      { id: 'a', __cursor_sort: new Date('2026-03-04T05:06:07.000Z'), __cursor_id: 'a' },
      { id: 'b', __cursor_sort: new Date('2026-03-05T05:06:07.000Z'), __cursor_id: 'b' },
    ]);
    const page = await runGrid(SOURCE, GRID, { paginate: 'cursor', limit: 1 }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt' },
    });
    expect(decodeCursor(page.nextCursor!).v).toBe('2026-03-04T05:06:07.000Z');
  });

  it('projects ?fields= in cursor mode too', async () => {
    const { execute } = recorder([
      { id: 'a', label: 'n', status: 'ok', __cursor_sort: 'x', __cursor_id: 'a' },
    ]);
    const page = await runGrid(SOURCE, GRID, { paginate: 'cursor', fields: 'label' }, execute, {
      idExpr: 'id',
      cursorDefaultSort: { field: 'startedAt' },
    });
    expect(page.items[0]).toEqual({ label: 'n' });
  });
});
