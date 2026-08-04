import { JobRow } from './jobs.service';

/**
 * In-memory stand-in for `api_jobs` used by the job executor specs.
 *
 * It models the two behaviours the executor's correctness depends on:
 *
 *  - `FOR UPDATE SKIP LOCKED`: a row is locked atomically at the instant it is
 *    selected, and a concurrent claimer SKIPS it rather than blocking. That is
 *    why two workers racing one job produce exactly one claim.
 *  - transaction scope: locks are released when the tenant transaction ends.
 *
 * Nothing here is production code — it lives beside the specs so both the
 * worker spec and the service spec can share one faithful fake instead of
 * two divergent hand-rolled mocks.
 */
export class FakeJobQueue {
  rows: JobRow[] = [];
  /** Row ids currently locked by an open transaction. */
  private readonly locked = new Set<string>();
  /** Every SQL statement executed, for assertions about what was run. */
  readonly statements: string[] = [];
  /** Resolved before each transaction body runs, to force interleaving. */
  yieldBeforeWork = true;

  seed(row: Partial<JobRow> & { id: string }): JobRow {
    const full: JobRow = {
      type: 'test.job',
      status: 'queued',
      progress: 0,
      input: {},
      result: {},
      error: null,
      requested_by: 'operator',
      idempotency_key: null,
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: new Date(0).toISOString(),
      last_error: null,
      claimed_at: null,
      claimed_by: null,
      heartbeat_at: null,
      dead_lettered_at: null,
      started_at: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  find(id: string): JobRow | undefined {
    return this.rows.find((row) => row.id === id);
  }

  /** A DatabaseService-shaped double. */
  asDatabase(tenants: string[] = ['1']) {
    return {
      query: (sql: string) => {
        this.statements.push(sql);
        if (sql.includes('FROM tenants')) return { rows: tenants.map((id) => ({ id })) };
        return { rows: [] };
      },
      tenantTransaction: <T>(_tenantId: string, work: (client: any) => Promise<T>): Promise<T> =>
        this.transaction(work),
    };
  }

  private async transaction<T>(work: (client: any) => Promise<T>): Promise<T> {
    const held: string[] = [];
    const client = {
      query: (sql: string, params: unknown[] = []) => this.execute(sql, params, held),
    };
    if (this.yieldBeforeWork) await Promise.resolve();
    try {
      return await work(client);
    } finally {
      for (const id of held) this.locked.delete(id);
    }
  }

  private async execute(sql: string, params: unknown[], held: string[]) {
    this.statements.push(sql);

    // ---- claim (SELECT ... FOR UPDATE SKIP LOCKED) --------------------------
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const now = Date.now();
      const candidate = this.rows
        .filter(
          (row) =>
            row.status === 'queued' &&
            !this.locked.has(row.id) &&
            new Date(row.next_attempt_at).getTime() <= now,
        )
        .sort(
          (a, b) =>
            new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime() ||
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        )[0];
      if (!candidate) return { rows: [] };
      // Atomic, exactly as SKIP LOCKED is inside PostgreSQL.
      this.locked.add(candidate.id);
      held.push(candidate.id);
      await Promise.resolve();
      candidate.status = 'running';
      candidate.attempts += 1;
      candidate.claimed_by = String(params[0]);
      candidate.claimed_at = new Date().toISOString();
      candidate.heartbeat_at = new Date().toISOString();
      candidate.started_at = candidate.started_at ?? new Date().toISOString();
      return { rows: [{ ...candidate }] };
    }

    // ---- success ------------------------------------------------------------
    if (sql.includes("status='succeeded'")) {
      const row = this.find(String(params[0]));
      if (!row || row.status !== 'running') return { rows: [] };
      row.status = 'succeeded';
      row.progress = 100;
      row.result = JSON.parse(String(params[1]));
      row.error = null;
      row.completed_at = new Date().toISOString();
      row.claimed_by = null;
      return { rows: [{ ...row }] };
    }

    // ---- dead letter --------------------------------------------------------
    if (sql.includes("status='dead_letter'") && sql.includes('WHERE id=$1')) {
      const row = this.find(String(params[0]));
      if (!row || row.status !== 'running') return { rows: [] };
      row.status = 'dead_letter';
      row.error = String(params[1]);
      row.last_error = String(params[1]);
      row.dead_lettered_at = new Date().toISOString();
      row.completed_at = new Date().toISOString();
      row.claimed_by = null;
      return { rows: [{ ...row }] };
    }

    // ---- retry with backoff --------------------------------------------------
    if (sql.includes("status='queued',last_error=$2")) {
      const row = this.find(String(params[0]));
      if (!row || row.status !== 'running') return { rows: [] };
      row.status = 'queued';
      row.last_error = String(params[1]);
      row.next_attempt_at = new Date(Date.now() + Number(params[2]) * 1000).toISOString();
      row.claimed_at = null;
      row.claimed_by = null;
      row.heartbeat_at = null;
      return { rows: [{ ...row }] };
    }

    // ---- cancel ---------------------------------------------------------------
    if (sql.includes("status='cancelled'")) {
      const row = this.find(String(params[0]));
      if (!row || !['queued', 'running'].includes(row.status)) return { rows: [] };
      row.status = 'cancelled';
      row.error = String(params[1]);
      row.completed_at = new Date().toISOString();
      return { rows: [{ ...row }] };
    }

    // ---- progress / heartbeat -------------------------------------------------
    if (sql.includes('SET progress=$2')) {
      const row = this.find(String(params[0]));
      if (row && row.status === 'running') {
        row.progress = Number(params[1]);
        row.heartbeat_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    // ---- reap stuck claims ------------------------------------------------------
    if (sql.includes('heartbeat_at <')) {
      const cutoff = Date.now() - Number(params[0]) * 1000;
      const stale = this.rows.filter(
        (row) =>
          row.status === 'running' &&
          row.heartbeat_at !== null &&
          new Date(row.heartbeat_at).getTime() < cutoff,
      );
      const exhausted = sql.includes('attempts >= max_attempts');
      const affected = stale.filter((row) =>
        exhausted ? row.attempts >= row.max_attempts : row.attempts < row.max_attempts,
      );
      for (const row of affected) {
        if (exhausted) {
          row.status = 'dead_letter';
          row.dead_lettered_at = new Date().toISOString();
        } else {
          row.status = 'queued';
          row.next_attempt_at = new Date(0).toISOString();
        }
        row.claimed_by = null;
        row.heartbeat_at = null;
      }
      return { rows: affected.map((row) => ({ id: row.id })) };
    }

    return { rows: [] };
  }
}
