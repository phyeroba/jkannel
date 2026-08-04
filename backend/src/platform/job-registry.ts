import { BadRequestException, Injectable } from '@nestjs/common';

/**
 * Registry of job types the executor knows how to run.
 *
 * This exists to prevent the exact defect that made `POST /jobs` dishonest: a
 * row could be written for ANY well-formed type string, and if nothing knew how
 * to run that type the job sat in `queued` forever with no error. Here, a type
 * with no registered handler is rejected at submission (400) and, should such a
 * row already exist, dead-lettered by the worker on first sight rather than
 * retried. There is no path by which an unrunnable job silently waits.
 *
 * Handlers register themselves from their owning module at boot (see
 * backup-dr/backup-job.handlers.ts), so the platform layer never has to import
 * a domain module.
 */

export interface JobActorContext {
  tenantId: string;
  /** The `requested_by` recorded on the job row. */
  userId: string;
}

export interface JobContext {
  jobId: string;
  type: string;
  actor: JobActorContext;
  /** Parsed `input` JSON from the job row; always an object. */
  input: Record<string, unknown>;
  /** 1-based attempt number for this execution. */
  attempt: number;
  maxAttempts: number;
  /** Reports progress (0-100) back onto the job row. Best effort. */
  progress(percent: number): Promise<void>;
}

/** A handler returns the value stored in the job's `result` column. */
export type JobHandler = (context: JobContext) => Promise<unknown>;

export interface JobHandlerRegistration {
  /** Lower-case job type identifier, e.g. "backup.create". */
  type: string;
  handler: JobHandler;
  /** Human description surfaced by GET /jobs/types. */
  description: string;
  /**
   * Attempts allowed before the job is dead-lettered. Defaults to
   * JOB_DEFAULT_MAX_ATTEMPTS (3). Use 1 for work that must never be retried.
   */
  maxAttempts?: number;
}

/**
 * Thrown by a handler when the failure is permanent (bad input, a resource that
 * will never exist). The worker dead-letters immediately instead of burning
 * retries on work that cannot succeed.
 */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export function isPermanentJobError(error: unknown): boolean {
  return (
    error instanceof PermanentJobError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { permanent?: unknown }).permanent === true)
  );
}

export const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_.-]+$/;

@Injectable()
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, Required<JobHandlerRegistration>>();

  register(registration: JobHandlerRegistration): void {
    const { type } = registration;
    if (!JOB_TYPE_PATTERN.test(type))
      throw new Error(`Invalid job type "${type}": expected a lower-case job type identifier`);
    if (this.handlers.has(type))
      throw new Error(`Job type "${type}" is already registered; types must be unique`);
    const maxAttempts = registration.maxAttempts ?? defaultMaxAttempts();
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50)
      throw new Error(`Job type "${type}" declares an out-of-range maxAttempts`);
    this.handlers.set(type, { ...registration, maxAttempts });
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Returns the registration, or undefined when the type is unknown. */
  get(type: string): Required<JobHandlerRegistration> | undefined {
    return this.handlers.get(type);
  }

  /**
   * Returns the registration or throws a 400 naming the supported types. Used
   * at submission so an unrunnable job is never accepted.
   */
  require(type: string): Required<JobHandlerRegistration> {
    const found = this.handlers.get(type);
    if (!found)
      throw new BadRequestException(
        this.types().length
          ? `Unknown job type "${type}". No executor is registered for it, so the job would never run. Supported types: ${this.types().join(', ')}`
          : `Unknown job type "${type}". No job executors are registered in this deployment, so no job can run.`,
      );
    return found;
  }

  /** Sorted list of registered type identifiers. */
  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Catalog for GET /jobs/types. */
  describe(): Array<{ type: string; description: string; maxAttempts: number }> {
    return this.types().map((type) => {
      const registration = this.handlers.get(type)!;
      return {
        type,
        description: registration.description,
        maxAttempts: registration.maxAttempts,
      };
    });
  }

  /** Test-only reset so specs start from a known registry. */
  clear(): void {
    this.handlers.clear();
  }
}

export function defaultMaxAttempts(): number {
  const parsed = Number(process.env.JOB_DEFAULT_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 3;
}

/**
 * Exponential backoff with a hard ceiling. `attempt` is the number of attempts
 * already made (1 after the first failure). Deterministic by design so the
 * schedule is testable and an operator can predict when a job retries:
 *
 *   attempt 1 -> base, 2 -> 2*base, 3 -> 4*base, ... capped at max.
 */
export function backoffMs(
  attempt: number,
  base = Number(process.env.JOB_RETRY_BASE_MS ?? 5_000),
  max = Number(process.env.JOB_RETRY_MAX_MS ?? 300_000),
): number {
  const safeBase = Number.isFinite(base) && base > 0 ? base : 5_000;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 300_000;
  const exponent = Math.max(0, Math.min(attempt - 1, 20));
  return Math.min(safeBase * 2 ** exponent, safeMax);
}
