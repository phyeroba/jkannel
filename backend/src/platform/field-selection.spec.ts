import { BadRequestException } from '@nestjs/common';
import { GridDefinition } from './list-query';
import {
  gridSelectableFields,
  parseFieldSelection,
  projectFields,
  projectItems,
} from './field-selection';

const ALLOWED = ['id', 'name', 'created_at'];

describe('parseFieldSelection', () => {
  it('returns null (all fields) when no projection is requested', () => {
    expect(parseFieldSelection(undefined, ALLOWED)).toBeNull();
    expect(parseFieldSelection('', ALLOWED)).toBeNull();
    expect(parseFieldSelection('   ', ALLOWED)).toBeNull();
  });

  it('parses, de-duplicates and preserves order of whitelisted fields', () => {
    expect(parseFieldSelection('name, id ,name', ALLOWED)).toEqual(['name', 'id']);
  });

  it('rejects unknown fields by default (strict)', () => {
    expect(() => parseFieldSelection('name,secret', ALLOWED)).toThrow(BadRequestException);
  });

  it('ignores unknown fields when strict is disabled', () => {
    expect(parseFieldSelection('name,secret', ALLOWED, { strict: false })).toEqual(['name']);
    // All requested unknown -> safe fallback to all fields (null), never a leak.
    expect(parseFieldSelection('secret', ALLOWED, { strict: false })).toBeNull();
  });
});

describe('projectFields / projectItems', () => {
  const row = { id: '1', name: 'Acme', created_at: 't', secret: 'x' };

  it('returns the object unchanged for a null selection', () => {
    expect(projectFields(row, null)).toBe(row);
  });

  it('trims to only the selected fields', () => {
    expect(projectFields(row, ['id', 'name'])).toEqual({ id: '1', name: 'Acme' });
  });

  it('never emits a field that is not present on the object', () => {
    expect(projectFields({ id: '1' }, ['id', 'name'])).toEqual({ id: '1' });
  });

  it('projects each item in a list', () => {
    const items = [
      { id: '1', name: 'A', secret: 'x' },
      { id: '2', name: 'B', secret: 'y' },
    ];
    expect(projectItems(items, ['id'])).toEqual([{ id: '1' }, { id: '2' }]);
    expect(projectItems(items, null)).toBe(items);
  });
});

describe('gridSelectableFields', () => {
  it('derives the union of sort and filter field names from a grid', () => {
    const grid: GridDefinition = {
      searchColumns: ['name'],
      sortColumns: { name: 'name', createdAt: 'created_at' },
      filterColumns: { enabled: 'enabled', name: 'name' },
      defaultOrderBy: 'name',
    };
    expect(gridSelectableFields(grid).sort()).toEqual(['createdAt', 'enabled', 'name']);
  });
});
