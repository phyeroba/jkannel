import { BadRequestException } from '@nestjs/common';
import { GridDefinition, buildGridSql, parseListQuery } from './list-query';

const grid: GridDefinition = {
  searchColumns: ['s.name', 's.host'],
  sortColumns: { name: 's.name', createdAt: 's.created_at' },
  filterColumns: { type: 's.type', enabled: 's.enabled' },
  defaultOrderBy: 's.priority, s.name',
};

describe('list-query', () => {
  it('parses search, multi-sort, filters and pagination', () => {
    const parsed = parseListQuery(
      {
        search: ' smpp ',
        sort: '-createdAt,name',
        'filter.type': 'smpp',
        limit: '25',
        offset: '50',
      },
      grid,
    );
    expect(parsed).toEqual({
      search: 'smpp',
      sort: [
        { field: 'createdAt', direction: 'DESC' },
        { field: 'name', direction: 'ASC' },
      ],
      filters: [{ field: 'type', value: 'smpp' }],
      limit: 25,
      offset: 50,
    });
  });

  it('rejects non-whitelisted sort and filter fields', () => {
    expect(() => parseListQuery({ sort: 'password' }, grid)).toThrow(BadRequestException);
    expect(() => parseListQuery({ 'filter.password': 'x' }, grid)).toThrow(BadRequestException);
    expect(() => parseListQuery({ limit: '99999' }, grid)).toThrow(BadRequestException);
  });

  it('builds parameterized SQL fragments only from whitelisted expressions', () => {
    const parsed = parseListQuery(
      { search: "x'; DROP TABLE users; --", sort: '-name', 'filter.enabled': 'true' },
      grid,
    );
    const sql = buildGridSql(parsed, grid, ['tenant-1']);
    expect(sql.andWhere).toBe(
      ' AND (s.name::text ILIKE $2 OR s.host::text ILIKE $2) AND s.enabled::text = $3',
    );
    expect(sql.orderBy).toBe('ORDER BY s.name DESC');
    expect(sql.limitOffset).toBe('LIMIT $4 OFFSET $5');
    expect(sql.params).toEqual(['tenant-1', "%x'; DROP TABLE users; --%", 'true', 50, 0]);
  });

  it('falls back to the default order and paginates safely', () => {
    const parsed = parseListQuery({}, grid);
    const sql = buildGridSql(parsed, grid);
    expect(sql.andWhere).toBe('');
    expect(sql.orderBy).toBe('ORDER BY s.priority, s.name');
    expect(sql.params).toEqual([50, 0]);
  });
});
