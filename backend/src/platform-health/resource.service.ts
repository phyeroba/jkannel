import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
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

const CGROUP = '/sys/fs/cgroup';

/**
 * Reads this container's own resource accounting (spec §14).
 *
 * Nothing here reads the host. See resource-usage.ts for why `os.totalmem()`
 * and `os.loadavg()` are deliberately not used: inside a container they report
 * the host's figures, which on a shared VPS means reporting another stack's
 * load as JKANNEL's.
 */
@Injectable()
export class ResourceService {
  /**
   * The previous CPU sample, kept so a rate can be computed.
   *
   * CPU usage is a rate; one cumulative counter cannot express one. The first
   * call after boot therefore reports null rather than a number, and says why.
   */
  private lastCpu: { usageMicros: number; atMs: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async snapshot(): Promise<ResourceSnapshot & { pressure: string }> {
    const memory = process.memoryUsage();
    const base = {
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      notMeasured: NOT_MEASURED,
      observedAt: new Date(this.now()).toISOString(),
    };

    const [memoryCurrent, memoryMax, cpuStat, cpuMax] = await Promise.all([
      read(`${CGROUP}/memory.current`),
      read(`${CGROUP}/memory.max`),
      read(`${CGROUP}/cpu.stat`),
      read(`${CGROUP}/cpu.max`),
    ]);

    if (memoryCurrent === null && cpuStat === null) {
      // cgroup v1, a non-Linux host, or not containerised. Report the process
      // figures — which are real — and say plainly that the container view is
      // missing, rather than substituting host numbers for container ones.
      const snapshot: ResourceSnapshot = {
        ...base,
        scope: 'process-only',
        memory: { usedBytes: memory.rss, limitBytes: null, percent: null },
        cpu: { usageMicros: null, limitCores: null, percent: null },
        unavailableReason:
          'cgroup v2 accounting is not present at /sys/fs/cgroup, so this container’s memory limit and CPU quota cannot be read. Only this process’s own figures are shown.',
      };
      return { ...snapshot, pressure: describePressure(snapshot) };
    }

    const usedBytes = parseCgroupNumber(memoryCurrent) ?? memory.rss;
    const limitBytes = parseCgroupNumber(memoryMax);
    const usageMicros = parseCpuUsage(cpuStat);
    const limitCores = parseCpuMax(cpuMax);

    let cpuPercent: number | null = null;
    if (usageMicros !== null) {
      const current = { usageMicros, atMs: this.now() };
      cpuPercent = cpuPercentBetween(this.lastCpu, current, limitCores);
      this.lastCpu = current;
    }

    const snapshot: ResourceSnapshot = {
      ...base,
      scope: 'container',
      memory: { usedBytes, limitBytes, percent: percentOf(usedBytes, limitBytes) },
      cpu: { usageMicros, limitCores, percent: cpuPercent },
      unavailableReason: null,
    };
    return { ...snapshot, pressure: describePressure(snapshot) };
  }
}

/** Missing or unreadable is a normal outcome here, not an error. */
async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
