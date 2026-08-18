import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * Prometheus exporter for the job queue.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The `/metrics` scrape said nothing at all about the job queue. Scheduled
 * sends, MO fan-out, delivery retries and report generation all run through
 * `api_jobs`, and the only way to learn that any of it had stopped was to open
 * `GET /jobs?filter.status=...` in a browser and read a total — one page fetch
 * per status, by a human who had already decided to look.
 *
 * The worker computes exactly these numbers every cycle
 * ({@link JobCycleSummary} in job-worker.ts) and throws them away. This asks
 * the TABLE instead, deliberately: the table survives a worker restart, so a
 * queue backing up because the worker is dead still reports, which is precisely
 * the case an in-process counter would go silent for.
 *
 * ---------------------------------------------------------------------------
 * WHAT "STUCK" MEANS AND WHY IT IS ITS OWN GAUGE
 * ---------------------------------------------------------------------------
 * A `running` job whose `heartbeat_at` has gone stale is a job whose worker died
 * mid-execution. It is not pending (nothing will re-claim it until the reaper
 * runs) and it is not failed (nothing recorded a failure). Folded into
 * `running` it looks like healthy work in progress, which is how a wedged queue
 * stays invisible. It gets its own gauge.
 */
@Injectable()
export class JobMetricsService {
  constructor(private readonly database: DatabaseService) {}

  /** Seconds after which a `running` job with no heartbeat is considered stuck. */
  private claimTimeoutSeconds(): number {
    const configured = Number(process.env.JOB_CLAIM_TIMEOUT_MS ?? 600_000);
    return Number.isFinite(configured) && configured > 0 ? Math.round(configured / 1000) : 600;
  }

  /**
   * Never throws. An unreachable database emits `jkannel_job_queue_up 0` rather
   * than failing the whole scrape — the same contract every other exporter here
   * follows, and the reason a partial outage still produces usable telemetry.
   */
  async render(): Promise<string> {
    const timeout = this.claimTimeoutSeconds();
    try {
      const { rows } = await this.database.query<{
        pending: string;
        overdue: string;
        running: string;
        stuck: string;
        dead: string;
        oldest_overdue_seconds: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'pending')                                   AS pending,
           count(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= now())      AS overdue,
           count(*) FILTER (WHERE status = 'running')                                   AS running,
           count(*) FILTER (WHERE status = 'running'
                              AND coalesce(heartbeat_at, claimed_at)
                                  < now() - ($1 || ' seconds')::interval)               AS stuck,
           count(*) FILTER (WHERE status = 'dead_letter')                               AS dead,
           EXTRACT(EPOCH FROM (now() - min(next_attempt_at)
             FILTER (WHERE status = 'pending' AND next_attempt_at <= now())))::text     AS oldest_overdue_seconds
         FROM api_jobs`,
        [String(timeout)],
      );
      const row = rows[0];
      return [
        '# HELP jkannel_job_queue_up Job queue readability as a boolean gauge.',
        '# TYPE jkannel_job_queue_up gauge',
        'jkannel_job_queue_up 1',
        '# HELP jkannel_jobs_pending Jobs waiting, including those scheduled for the future.',
        '# TYPE jkannel_jobs_pending gauge',
        `jkannel_jobs_pending ${int(row.pending)}`,
        // The gauge to alert on. Depth alone is not a fault: a thousand jobs
        // scheduled for tomorrow is a healthy queue. Work that was DUE and has
        // not run is the signal.
        '# HELP jkannel_jobs_overdue Jobs whose scheduled time has passed and which have not run.',
        '# TYPE jkannel_jobs_overdue gauge',
        `jkannel_jobs_overdue ${int(row.overdue)}`,
        '# HELP jkannel_jobs_running Jobs currently claimed by a worker.',
        '# TYPE jkannel_jobs_running gauge',
        `jkannel_jobs_running ${int(row.running)}`,
        '# HELP jkannel_jobs_stuck Running jobs whose worker heartbeat has gone stale.',
        '# TYPE jkannel_jobs_stuck gauge',
        `jkannel_jobs_stuck ${int(row.stuck)}`,
        '# HELP jkannel_jobs_dead_lettered Jobs that exhausted their retries and need a decision.',
        '# TYPE jkannel_jobs_dead_lettered gauge',
        `jkannel_jobs_dead_lettered ${int(row.dead)}`,
        // Age, not just count: one job overdue by two hours is a worse signal
        // than fifty overdue by ten seconds, and a count cannot tell them apart.
        '# HELP jkannel_job_oldest_overdue_seconds Age of the oldest overdue job, 0 when none.',
        '# TYPE jkannel_job_oldest_overdue_seconds gauge',
        `jkannel_job_oldest_overdue_seconds ${int(row.oldest_overdue_seconds)}`,
        '# HELP jkannel_job_claim_timeout_seconds Heartbeat age after which a running job counts as stuck.',
        '# TYPE jkannel_job_claim_timeout_seconds gauge',
        `jkannel_job_claim_timeout_seconds ${timeout}`,
      ].join('\n');
    } catch {
      return [
        '# HELP jkannel_job_queue_up Job queue readability as a boolean gauge.',
        '# TYPE jkannel_job_queue_up gauge',
        'jkannel_job_queue_up 0',
      ].join('\n');
    }
  }
}

/** Rounds and floors at zero. A negative or non-numeric gauge is never emitted. */
function int(value: string | number | null | undefined): number {
  const parsed = Math.round(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
