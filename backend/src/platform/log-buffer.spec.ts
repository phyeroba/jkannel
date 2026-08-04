import { LogBufferService, LogEntry, sharedLogBuffer } from './log-buffer';

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: '2026-08-01T00:00:00.000Z',
  level: 'info',
  message: 'hello',
  ...over,
});

describe('LogBufferService', () => {
  it('keeps newest-first order and applies the limit', () => {
    const buffer = new LogBufferService(10);
    for (let index = 0; index < 5; index += 1)
      buffer.push(
        entry({ message: `line-${index}`, timestamp: `2026-08-01T00:00:0${index}.000Z` }),
      );
    const result = buffer.query({ limit: 2 });
    expect(result.items.map((item) => item.message)).toEqual(['line-4', 'line-3']);
    expect(result.matched).toBe(5);
  });

  it('evicts the oldest entries once capacity is exceeded and says how many', () => {
    const buffer = new LogBufferService(3);
    for (let index = 0; index < 6; index += 1) buffer.push(entry({ message: `line-${index}` }));
    const result = buffer.query();
    expect(result.stored).toBe(3);
    expect(result.dropped).toBe(3);
    expect(result.items.map((item) => item.message)).toEqual(['line-5', 'line-4', 'line-3']);
  });

  it('filters by correlation id — the "trace this incident" query', () => {
    const buffer = new LogBufferService(10);
    buffer.push(entry({ message: 'a', correlationId: 'corr-1' }));
    buffer.push(entry({ message: 'b', correlationId: 'corr-2' }));
    buffer.push(entry({ message: 'c', correlationId: 'corr-1' }));
    const result = buffer.query({ correlationId: 'corr-1' });
    expect(result.matched).toBe(2);
    expect(result.items.map((item) => item.message)).toEqual(['c', 'a']);
  });

  it('filters by exact level and by minimum level', () => {
    const buffer = new LogBufferService(10);
    buffer.push(entry({ level: 'debug', message: 'd' }));
    buffer.push(entry({ level: 'warn', message: 'w' }));
    buffer.push(entry({ level: 'error', message: 'e' }));
    expect(buffer.query({ level: 'warn' }).items.map((i) => i.message)).toEqual(['w']);
    expect(buffer.query({ minLevel: 'warn' }).matched).toBe(2);
  });

  it('filters by tenant, route, substring and time window', () => {
    const buffer = new LogBufferService(10);
    buffer.push(
      entry({
        message: 'submit failed',
        tenantId: '1',
        route: '/api/v1/messages',
        timestamp: '2026-08-01T00:00:00.000Z',
      }),
    );
    buffer.push(
      entry({
        message: 'ok',
        tenantId: '2',
        route: '/api/v1/alerts',
        timestamp: '2026-08-01T02:00:00.000Z',
      }),
    );
    expect(buffer.query({ tenantId: '1' }).matched).toBe(1);
    expect(buffer.query({ route: '/alerts' }).matched).toBe(1);
    expect(buffer.query({ contains: 'FAILED' }).matched).toBe(1);
    expect(buffer.query({ since: '2026-08-01T01:00:00.000Z' }).matched).toBe(1);
    expect(buffer.query({ until: '2026-08-01T01:00:00.000Z' }).matched).toBe(1);
  });

  it('never claims durability', () => {
    const result = new LogBufferService(2).query();
    expect(result.durable).toBe(false);
    expect(result.scope).toBe('process');
    expect(result.notice).toContain('not durable');
    expect(result.notice).toContain('THIS process');
  });

  it('shares one process-wide instance so the logger and the endpoint agree', () => {
    expect(sharedLogBuffer()).toBe(sharedLogBuffer());
  });
});
