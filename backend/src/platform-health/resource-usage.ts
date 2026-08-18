/**
 * Resource pressure, and the honest limits of measuring it from in here
 * (spec §14 "Nodes / Performance").
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NODES SCREEN
 * ---------------------------------------------------------------------------
 * The design kit draws a Nodes table: several hosts, each with CPU, memory,
 * disk, network I/O, load average and a software version. JKANNEL cannot
 * produce that. The backend has no Docker socket (verified — its only volumes
 * are the Kamex runtime directory and the migrations directory), no agent runs
 * on the hosts, and there is no node inventory anywhere in the schema. Every
 * figure in that table would be invented.
 *
 * What CAN be measured is this process's own container. So that is what this
 * reports, and it is labelled as what it is rather than dressed up as a host.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `os.cpus()` AND `os.totalmem()`
 * ---------------------------------------------------------------------------
 * Those are the tempting one-liners and they are actively misleading inside a
 * container: neither is namespaced, so `os.totalmem()` returns the HOST's RAM
 * and `os.loadavg()` returns the HOST's load — including every other container
 * on the box. On the VPS this backend shares, that means reporting the CPaaS
 * stack's load as JKANNEL's. A number that is wrong in a way the reader cannot
 * detect is worse than no number.
 *
 * cgroup v2 exposes the container's OWN accounting under /sys/fs/cgroup, which
 * is what a container's limit and usage actually mean. When those files are
 * absent (cgroup v1, a non-Linux host, a non-containerised run) this reports
 * `unavailable` with the reason instead of falling back to the host figures.
 */

export interface ResourceReading {
  /** Bytes in use, or null when it could not be read. */
  usedBytes: number | null;
  /** The container's ceiling, or null when it is unlimited or unreadable. */
  limitBytes: number | null;
  /** 0–100, only when BOTH numbers are real. Never a stand-in. */
  percent: number | null;
}

export interface CpuReading {
  /** Cumulative CPU microseconds consumed by this container. */
  usageMicros: number | null;
  /** Cores this container may use, or null when uncapped. */
  limitCores: number | null;
  /**
   * Share of the quota used between two samples, 0–100.
   *
   * Null on the first sample. CPU usage is a RATE and a single cumulative
   * counter cannot express one — reporting the raw total as a percentage is a
   * classic way to render a busy container as 0% and an idle one as 4000%.
   */
  percent: number | null;
}

export interface ProcessReading {
  /** Seconds this backend process has been up. */
  uptimeSeconds: number;
  /** Resident set size — what this process actually holds in RAM. */
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
}

export interface ResourceSnapshot {
  scope: 'container' | 'process-only';
  memory: ResourceReading;
  cpu: CpuReading;
  process: ProcessReading;
  /** Present when container accounting could not be read. Rendered verbatim. */
  unavailableReason: string | null;
  /** What this snapshot deliberately does NOT measure. Never empty. */
  notMeasured: string[];
  observedAt: string;
}

/**
 * Things no code in this system can observe, stated as data.
 *
 * Kept as a list rather than prose so the console can render it as content
 * (§17: an absent figure means not observable, never zero) instead of a screen
 * quietly having fewer columns than the specification asked for.
 */
export const NOT_MEASURED = [
  'Host CPU, memory, disk and load — the backend has no host agent and no Docker socket',
  'Other nodes — there is no node inventory; this deployment is observed from inside one container',
  'Disk free space — no filesystem is mounted for measurement; the only disk figure anywhere is the logical database size',
  'Per-service CPU and memory for bearerbox, smsbox and sqlbox — they are separate containers and nothing collects from them',
  'Network I/O — no interface counters are read; nothing in this deployment samples them',
];

/** `max` means uncapped in cgroup v2, and uncapped is not a number. */
export function parseCgroupNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text || text === 'max') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `cpu.max` is "<quota> <period>", both in microseconds; "max <period>" is
 * uncapped. quota/period is the number of cores this container may use.
 */
export function parseCpuMax(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const [quota, period] = String(raw).trim().split(/\s+/);
  const quotaValue = parseCgroupNumber(quota);
  const periodValue = parseCgroupNumber(period);
  if (quotaValue === null || !periodValue) return null;
  return quotaValue / periodValue;
}

/** The `usage_usec` line of `cpu.stat`. */
export function parseCpuUsage(raw: string | null | undefined): number | null {
  if (!raw) return null;
  for (const line of String(raw).split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === 'usage_usec') return parseCgroupNumber(value);
  }
  return null;
}

export function percentOf(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
}

/**
 * CPU percentage between two cumulative samples.
 *
 * Returns null rather than a number when: this is the first sample, the counter
 * went backwards (a restart), no time passed, or the container is uncapped —
 * in the last case there is no denominator, so a percentage would be a
 * fabrication.
 */
export function cpuPercentBetween(
  previous: { usageMicros: number; atMs: number } | null,
  current: { usageMicros: number; atMs: number },
  limitCores: number | null,
): number | null {
  if (!previous || limitCores === null || limitCores <= 0) return null;
  const elapsedMs = current.atMs - previous.atMs;
  const consumedMicros = current.usageMicros - previous.usageMicros;
  if (elapsedMs <= 0 || consumedMicros < 0) return null;
  const availableMicros = elapsedMs * 1000 * limitCores;
  if (availableMicros <= 0) return null;
  return Math.round((consumedMicros / availableMicros) * 1000) / 10;
}

/**
 * The sentence a Nodes screen should lead with.
 *
 * The design kit's version picks the single resource under real pressure rather
 * than leaving the reader to scan a wall of gauges. This does the same, and says
 * plainly when nothing is under pressure — which is a finding, not an absence.
 */
export function describePressure(snapshot: ResourceSnapshot): string {
  if (snapshot.unavailableReason)
    return `Container resource accounting is not readable here, so no pressure can be reported. ${snapshot.unavailableReason}`;
  const memory = snapshot.memory.percent;
  const cpu = snapshot.cpu.percent;
  if (memory !== null && memory > 85)
    return `Memory at ${memory}% of this container's limit is the pressure worth acting on. Above 90% the kernel starts killing the process.`;
  if (cpu !== null && cpu > 85)
    return `CPU at ${cpu}% of this container's quota is the pressure worth acting on — requests will be queueing behind it.`;
  if (memory !== null && memory > 70)
    return `Memory at ${memory}% of this container's limit is worth watching, but is not yet affecting service.`;
  if (cpu !== null && cpu > 70)
    return `CPU at ${cpu}% of this container's quota is worth watching, but is not yet affecting service.`;
  if (memory === null && cpu === null)
    return 'No usable resource figures yet. CPU needs two samples before a rate can be stated.';
  return 'No resource is under material pressure in this container.';
}
