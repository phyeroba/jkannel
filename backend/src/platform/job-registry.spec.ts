import { BadRequestException } from '@nestjs/common';
import {
  backoffMs,
  defaultMaxAttempts,
  isPermanentJobError,
  JobHandlerRegistry,
  PermanentJobError,
} from './job-registry';

const handler = async () => ({});

describe('JobHandlerRegistry', () => {
  let registry: JobHandlerRegistry;
  beforeEach(() => {
    registry = new JobHandlerRegistry();
  });

  it('registers and resolves a job type', () => {
    registry.register({ type: 'backup.create', description: 'runs a backup', handler });
    expect(registry.has('backup.create')).toBe(true);
    expect(registry.require('backup.create').description).toBe('runs a backup');
  });

  it('rejects an unknown type with a 400 naming the supported types', () => {
    registry.register({ type: 'backup.create', description: 'x', handler });
    expect(() => registry.require('made.up')).toThrow(BadRequestException);
    expect(() => registry.require('made.up')).toThrow(/Supported types: backup.create/);
  });

  it('says so explicitly when nothing at all is registered', () => {
    expect(() => registry.require('anything')).toThrow(/No job executors are registered/);
  });

  it('refuses a duplicate registration instead of silently shadowing one', () => {
    registry.register({ type: 'backup.create', description: 'x', handler });
    expect(() => registry.register({ type: 'backup.create', description: 'y', handler })).toThrow(
      /already registered/,
    );
  });

  it('refuses a malformed type identifier', () => {
    expect(() => registry.register({ type: 'Backup Create', description: 'x', handler })).toThrow(
      /Invalid job type/,
    );
  });

  it('refuses an out-of-range maxAttempts', () => {
    expect(() =>
      registry.register({ type: 'a.b', description: 'x', handler, maxAttempts: 0 }),
    ).toThrow(/out-of-range/);
    expect(() =>
      registry.register({ type: 'c.d', description: 'x', handler, maxAttempts: 500 }),
    ).toThrow(/out-of-range/);
  });

  it('describes the catalog in sorted order', () => {
    registry.register({ type: 'z.job', description: 'z', handler, maxAttempts: 1 });
    registry.register({ type: 'a.job', description: 'a', handler, maxAttempts: 2 });
    expect(registry.describe()).toEqual([
      { type: 'a.job', description: 'a', maxAttempts: 2 },
      { type: 'z.job', description: 'z', maxAttempts: 1 },
    ]);
  });
});

describe('defaultMaxAttempts', () => {
  const original = process.env.JOB_DEFAULT_MAX_ATTEMPTS;
  afterEach(() => {
    if (original === undefined) delete process.env.JOB_DEFAULT_MAX_ATTEMPTS;
    else process.env.JOB_DEFAULT_MAX_ATTEMPTS = original;
  });

  it('defaults to 3', () => {
    delete process.env.JOB_DEFAULT_MAX_ATTEMPTS;
    expect(defaultMaxAttempts()).toBe(3);
  });

  it('reads a valid override', () => {
    process.env.JOB_DEFAULT_MAX_ATTEMPTS = '5';
    expect(defaultMaxAttempts()).toBe(5);
  });

  it('falls back to 3 for nonsense', () => {
    process.env.JOB_DEFAULT_MAX_ATTEMPTS = 'lots';
    expect(defaultMaxAttempts()).toBe(3);
  });
});

describe('PermanentJobError', () => {
  it('is recognised as permanent', () => {
    expect(isPermanentJobError(new PermanentJobError('bad input'))).toBe(true);
  });

  it('does not misclassify an ordinary error as permanent', () => {
    expect(isPermanentJobError(new Error('connection reset'))).toBe(false);
    expect(isPermanentJobError('a string')).toBe(false);
    expect(isPermanentJobError(null)).toBe(false);
  });
});

describe('backoffMs defaults', () => {
  it('uses a 5s base and a 5m ceiling out of the box', () => {
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(20)).toBe(300_000);
  });
});
