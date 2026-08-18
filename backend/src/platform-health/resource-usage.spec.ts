import {
  NOT_MEASURED,
  cpuPercentBetween,
  describePressure,
  parseCgroupNumber,
  parseCpuMax,
  parseCpuUsage,
  percentOf,
  type ResourceSnapshot,
} from './resource-usage';

const snapshot = (overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  scope: 'container',
  memory: { usedBytes: 100, limitBytes: 1000, percent: 10 },
  cpu: { usageMicros: 1000, limitCores: 1, percent: 5 },
  process: { uptimeSeconds: 60, rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80 },
  unavailableReason: null,
  notMeasured: NOT_MEASURED,
  observedAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

describe('parseCgroupNumber', () => {
  it('treats "max" as no limit rather than as a huge number', () => {
    // The bug this prevents: Number('max') is NaN, and a NaN limit that slips
    // through renders as a percentage of nothing.
    expect(parseCgroupNumber('max')).toBeNull();
    expect(parseCgroupNumber('9223372036854771712')).toBe(9223372036854771712);
  });

  it('rejects rubbish rather than coercing it', () => {
    expect(parseCgroupNumber('')).toBeNull();
    expect(parseCgroupNumber(null)).toBeNull();
    expect(parseCgroupNumber('not a number')).toBeNull();
    expect(parseCgroupNumber('-5')).toBeNull();
  });

  it('tolerates the trailing newline every cgroup file has', () => {
    expect(parseCgroupNumber('536870912\n')).toBe(536870912);
  });
});

describe('parseCpuMax', () => {
  it('turns "quota period" into a core count', () => {
    expect(parseCpuMax('50000 100000')).toBe(0.5);
    expect(parseCpuMax('200000 100000')).toBe(2);
  });

  it('reports an uncapped container as having no limit', () => {
    expect(parseCpuMax('max 100000')).toBeNull();
    expect(parseCpuMax(null)).toBeNull();
  });

  it('does not divide by a zero period', () => {
    expect(parseCpuMax('50000 0')).toBeNull();
  });
});

describe('parseCpuUsage', () => {
  it('finds usage_usec wherever it sits in the file', () => {
    expect(parseCpuUsage('usage_usec 123456\nuser_usec 100\nsystem_usec 23')).toBe(123456);
    expect(parseCpuUsage('nr_periods 4\nusage_usec 987\n')).toBe(987);
  });

  it('returns null when the field is absent, rather than guessing', () => {
    expect(parseCpuUsage('user_usec 100')).toBeNull();
    expect(parseCpuUsage(null)).toBeNull();
  });
});

describe('percentOf', () => {
  it('needs both numbers to be real', () => {
    expect(percentOf(500, 1000)).toBe(50);
    expect(percentOf(500, null)).toBeNull();
    expect(percentOf(null, 1000)).toBeNull();
    expect(percentOf(500, 0)).toBeNull();
  });
});

describe('cpuPercentBetween', () => {
  const at = (usageMicros: number, atMs: number) => ({ usageMicros, atMs });

  it('computes the share of quota used between two samples', () => {
    // Half a core-second consumed in one wall-clock second, on a one-core
    // quota, is 50%.
    expect(cpuPercentBetween(at(0, 0), at(500_000, 1000), 1)).toBe(50);
    // The same consumption on a two-core quota is half as much pressure.
    expect(cpuPercentBetween(at(0, 0), at(500_000, 1000), 2)).toBe(25);
  });

  it('reports null on the first sample instead of a number', () => {
    // A cumulative counter is not a rate. Publishing the raw total as a
    // percentage renders a busy container as 0% and a long-lived idle one as
    // thousands of percent.
    expect(cpuPercentBetween(null, at(500_000, 1000), 1)).toBeNull();
  });

  it('reports null when the container is uncapped — there is no denominator', () => {
    expect(cpuPercentBetween(at(0, 0), at(500_000, 1000), null)).toBeNull();
  });

  it('drops a sample where the counter went backwards', () => {
    // A restart resets usage_usec. Clamping to zero would draw a plausible dip;
    // refusing the interval says nothing rather than something false.
    expect(cpuPercentBetween(at(900_000, 0), at(1000, 1000), 1)).toBeNull();
  });

  it('does not divide by zero elapsed time', () => {
    expect(cpuPercentBetween(at(0, 1000), at(500_000, 1000), 1)).toBeNull();
  });
});

describe('describePressure', () => {
  it('names the single resource worth acting on', () => {
    expect(describePressure(snapshot({ memory: { usedBytes: 9, limitBytes: 10, percent: 90 } }))).toContain(
      'Memory at 90%',
    );
    expect(
      describePressure(
        snapshot({
          memory: { usedBytes: 1, limitBytes: 10, percent: 10 },
          cpu: { usageMicros: 1, limitCores: 1, percent: 92 },
        }),
      ),
    ).toContain('CPU at 92%');
  });

  it('separates "worth watching" from "worth acting on"', () => {
    const watching = describePressure(
      snapshot({ memory: { usedBytes: 75, limitBytes: 100, percent: 75 } }),
    );
    expect(watching).toContain('worth watching');
    expect(watching).toContain('not yet affecting service');
  });

  it('states the all-clear rather than saying nothing', () => {
    expect(describePressure(snapshot())).toBe(
      'No resource is under material pressure in this container.',
    );
  });

  it('explains an absent reading instead of implying everything is fine', () => {
    const text = describePressure(
      snapshot({
        scope: 'process-only',
        memory: { usedBytes: 100, limitBytes: null, percent: null },
        cpu: { usageMicros: null, limitCores: null, percent: null },
        unavailableReason: 'cgroup v2 accounting is not present.',
      }),
    );
    expect(text).toContain('no pressure can be reported');
    expect(text).toContain('cgroup v2 accounting is not present.');
  });

  it('says the first CPU sample is not yet a rate', () => {
    expect(
      describePressure(
        snapshot({
          memory: { usedBytes: 1, limitBytes: null, percent: null },
          cpu: { usageMicros: 1, limitCores: 1, percent: null },
        }),
      ),
    ).toContain('two samples');
  });
});

describe('NOT_MEASURED', () => {
  it('names the host figures, so an operator is not left assuming they exist', () => {
    const text = NOT_MEASURED.join(' ');
    expect(text).toMatch(/Host CPU/);
    expect(text).toMatch(/Disk free space/);
    expect(text).toMatch(/Other nodes/);
    // Each entry says WHY, not merely what — "no host agent and no Docker
    // socket" is actionable; "not available" is not.
    for (const entry of NOT_MEASURED) expect(entry.length).toBeGreaterThan(40);
  });
});
