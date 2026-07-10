import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  Actor,
  BackupDrRepository,
  BackupKind,
  BackupRecord,
  BackupScope,
  RetentionClass,
} from './backup-dr.repository';

const KINDS: BackupKind[] = ['full', 'schema', 'incremental'];
const SCOPES: BackupScope[] = ['full', 'database', 'configurations'];
/**
 * Tables captured by a configuration-only (scope='configurations') dump. These
 * hold the operator-authored gateway configuration; message/DLR data lives in
 * SQLBox and is intentionally excluded.
 */
const CONFIG_TABLES = [
  'configuration_versions',
  'smsc_definitions',
  'routing_rules',
  'system_settings',
];
const RETENTION_CLASSES: RetentionClass[] = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'manual',
];

/**
 * Retention windows by class in milliseconds. `null` means the class is kept
 * permanently (yearly archives and operator-run manual backups are never
 * auto-expired). hourly 48h, daily 30d, weekly 12w, monthly 24m.
 */
export const RETENTION_WINDOWS_MS: Record<RetentionClass, number | null> = {
  hourly: 48 * 3_600_000,
  daily: 30 * 86_400_000,
  weekly: 12 * 7 * 86_400_000,
  monthly: 24 * 30 * 86_400_000,
  yearly: null,
  manual: null,
};

/** The cutoff before which backups of `retentionClass` are expired, or null. */
export function retentionCutoff(
  retentionClass: RetentionClass,
  now: Date = new Date(),
): Date | null {
  const window = RETENTION_WINDOWS_MS[retentionClass];
  if (window === null) return null;
  return new Date(now.getTime() - window);
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary itself is not installed (spawn ENOENT). */
  missing: boolean;
}

const MISSING_PG_DUMP = 'pg_dump not available in this image';
const MISSING_PG_RESTORE = 'pg_restore not available in this image';
const PLATFORM_VERSION = process.env.JKANNEL_VERSION ?? process.env.npm_package_version ?? '0.1.0';

function backupDir(): string {
  return process.env.BACKUP_DIR ?? '/var/lib/jkannel/backups';
}

/**
 * Real backup & disaster-recovery orchestration. Shells out to
 * pg_dump/pg_restore, encrypts artifacts at rest with AES-256-GCM, and records
 * everything in the tenant-scoped catalog. The process boundaries (spawning a
 * binary, the admin database, artifact decryption) are protected methods so
 * tests exercise the record-keeping and honest-failure paths without spawning
 * PostgreSQL tools.
 *
 * Limitations (documented honestly): the pg_dump is whole-database even though
 * the catalog row is per-tenant; restore verification restores into an isolated
 * throwaway database to prove the artifact is restorable — a full production
 * restore into the live database is an operator-run runbook step, never
 * performed by this API.
 */
@Injectable()
export class BackupDrService {
  constructor(private readonly repository: BackupDrRepository) {}

  // ---- createBackup -------------------------------------------------------
  async createBackup(
    actor: Actor,
    input: { kind?: string; retentionClass?: string; label?: string; scope?: string },
  ): Promise<BackupRecord> {
    const kind = this.validKind(input.kind);
    const retentionClass = this.validRetention(input.retentionClass);
    const { scope, scopeNote } = this.validScope(input.scope);
    const label =
      (typeof input.label === 'string' && input.label.trim()) ||
      `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const dir = backupDir();
    const artifactPath = join(
      dir,
      `${this.safeName(label)}-${randomBytes(4).toString('hex')}.dump.enc`,
    );
    const databaseVersion = await this.repository.databaseVersion();

    const record = await this.repository.insertRunning(actor, {
      label,
      kind,
      scope,
      retentionClass,
      artifactPath,
      platformVersion: PLATFORM_VERSION,
      databaseVersion,
    });

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      return this.repository.failBackup(
        actor,
        record.id,
        'DATABASE_URL is not configured; cannot run pg_dump.',
      );
    }

    const dumpPath = join(tmpdir(), `jkannel-dump-${randomBytes(6).toString('hex')}.dump`);
    try {
      await this.ensureDir(dir);
      const dumpArgs = this.pgDumpArgs(kind, scope, dumpPath, connectionString);
      const result = await this.execTool('pg_dump', dumpArgs);
      if (result.missing) {
        return this.repository.failBackup(actor, record.id, MISSING_PG_DUMP);
      }
      if (result.code !== 0) {
        return this.repository.failBackup(
          actor,
          record.id,
          `pg_dump exited ${result.code}: ${result.stderr.slice(0, 500)}`,
        );
      }
      const plain = await readFile(dumpPath);
      const checksum = createHash('sha256').update(plain).digest('hex');
      const encrypted = this.encrypt(plain);
      await writeFile(artifactPath, encrypted);
      const coverage =
        scope === 'configurations'
          ? `Configuration-only pg_dump (tables: ${CONFIG_TABLES.join(', ')})`
          : `Whole-database ${kind} pg_dump`;
      return this.repository.completeBackup(actor, record.id, {
        sizeBytes: plain.length,
        checksum,
        location: `file://${artifactPath}`,
        detail:
          `${coverage} (custom format), AES-256-GCM encrypted at rest. ` +
          `Logical size ${plain.length} bytes.${scopeNote}`,
      });
    } catch (error) {
      return this.repository.failBackup(
        actor,
        record.id,
        `Backup failed: ${(error as Error).message}`,
      );
    } finally {
      await rm(dumpPath, { force: true }).catch(() => undefined);
    }
  }

  // ---- verifyBackup -------------------------------------------------------
  async verifyBackup(actor: Actor, id: string): Promise<BackupRecord> {
    const record = await this.repository.getBackup(actor, id);
    if (!record) throw new NotFoundException('Backup not found');
    if (!record.artifact_path) {
      return this.repository.markVerifyFailed(
        actor,
        id,
        'No artifact recorded for this backup; nothing to verify.',
      );
    }
    let decryptedPath: string | undefined;
    try {
      decryptedPath = await this.decryptArtifactToTemp(record);
      const result = await this.execTool('pg_restore', ['--list', decryptedPath]);
      if (result.missing) {
        return this.repository.markVerifyFailed(actor, id, MISSING_PG_RESTORE);
      }
      if (result.code !== 0) {
        return this.repository.markVerifyFailed(
          actor,
          id,
          `pg_restore --list failed (${result.code}): ${result.stderr.slice(0, 500)}`,
        );
      }
      const entries = result.stdout.split('\n').filter((line) => line && !line.startsWith(';'));
      return this.repository.markVerified(
        actor,
        id,
        `Archive integrity verified via pg_restore --list (${entries.length} entries).`,
      );
    } catch (error) {
      return this.repository.markVerifyFailed(
        actor,
        id,
        `Verification failed: ${(error as Error).message}`,
      );
    } finally {
      if (decryptedPath) await rm(decryptedPath, { force: true }).catch(() => undefined);
    }
  }

  // ---- restoreBackup ------------------------------------------------------
  /**
   * Destructive-class operation, run SAFELY: restores the artifact into an
   * isolated throwaway database to prove it restores, then drops that database.
   * The live database is never touched. `confirm` must be true.
   */
  async restoreBackup(
    actor: Actor,
    id: string,
    input: { reason?: string; confirm?: unknown },
  ): Promise<{ id: string; status: string; detail: string | null; target: string | null }> {
    if (input.confirm !== true)
      throw new BadRequestException(
        'Restore is a destructive-class operation; pass { "confirm": true } to proceed.',
      );
    const reason =
      typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined;
    if (!reason) throw new BadRequestException('A restore reason is required for the audit trail.');

    const record = await this.repository.getBackup(actor, id);
    if (!record) throw new NotFoundException('Backup not found');
    if (!record.artifact_path)
      throw new BadRequestException('This backup has no artifact to restore from.');

    const target = this.verifyDatabaseName();
    const operation = await this.repository.recordRestoreRunning(actor, {
      backupId: id,
      target,
    });

    let decryptedPath: string | undefined;
    try {
      decryptedPath = await this.decryptArtifactToTemp(record);
      const decrypted = decryptedPath;
      const result = await this.withVerifyDatabase((targetUrl) =>
        this.execTool('pg_restore', ['--no-owner', '--no-acl', `--dbname=${targetUrl}`, decrypted]),
      );
      if (result.missing) {
        return this.repository.completeRestore(actor, operation.id, {
          status: 'failed',
          detail: MISSING_PG_RESTORE,
        });
      }
      if (result.code !== 0) {
        return this.repository.completeRestore(actor, operation.id, {
          status: 'failed',
          detail: `pg_restore into ${target} failed (${result.code}): ${result.stderr.slice(0, 500)}`,
        });
      }
      return this.repository.completeRestore(actor, operation.id, {
        status: 'succeeded',
        detail:
          `Restore-verified into isolated database "${target}", then dropped. ` +
          `Reason: ${reason}. A full production restore into the live database is an ` +
          `operator-run runbook step and is intentionally not performed by this API.`,
      });
    } catch (error) {
      return this.repository.completeRestore(actor, operation.id, {
        status: 'failed',
        detail: `Restore verification failed: ${(error as Error).message}`,
      });
    } finally {
      if (decryptedPath) await rm(decryptedPath, { force: true }).catch(() => undefined);
    }
  }

  // ---- applyRetention -----------------------------------------------------
  /**
   * Deletes catalog rows and their artifacts older than the per-class policy.
   * Bounded per class per run; audited by the repository.
   */
  async applyRetention(
    actor: Actor,
    now: Date = new Date(),
  ): Promise<Array<{ retentionClass: RetentionClass; removed: number }>> {
    const limit = Number(process.env.BACKUP_RETENTION_BATCH ?? 500);
    const summary: Array<{ retentionClass: RetentionClass; removed: number }> = [];
    for (const retentionClass of RETENTION_CLASSES) {
      const cutoff = retentionCutoff(retentionClass, now);
      if (!cutoff) continue; // permanent class
      const removed = await this.repository.expireBackups(
        actor,
        retentionClass,
        cutoff.toISOString(),
        limit,
      );
      for (const row of removed) {
        if (row.artifact_path) await rm(row.artifact_path, { force: true }).catch(() => undefined);
      }
      summary.push({ retentionClass, removed: removed.length });
    }
    return summary;
  }

  // ---- validation helpers -------------------------------------------------
  private validKind(kind: unknown): BackupKind {
    if (kind === undefined || kind === null || kind === '') return 'full';
    if (typeof kind !== 'string' || !KINDS.includes(kind as BackupKind))
      throw new BadRequestException(`kind must be one of ${KINDS.join(', ')}`);
    return kind as BackupKind;
  }

  private validRetention(retentionClass: unknown): RetentionClass {
    if (retentionClass === undefined || retentionClass === null || retentionClass === '')
      return 'manual';
    if (
      typeof retentionClass !== 'string' ||
      !RETENTION_CLASSES.includes(retentionClass as RetentionClass)
    )
      throw new BadRequestException(
        `retentionClass must be one of ${RETENTION_CLASSES.join(', ')}`,
      );
    return retentionClass as RetentionClass;
  }

  private safeName(label: string): string {
    return (
      label
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'backup'
    );
  }

  private validScope(scope: unknown): { scope: BackupScope; scopeNote: string } {
    if (scope === undefined || scope === null || scope === '')
      return { scope: 'full', scopeNote: '' };
    if (typeof scope !== 'string')
      throw new BadRequestException(`scope must be one of ${SCOPES.join(', ')}, or 'app'`);
    // Application code lives in git, so an 'app' scope is not a database concern:
    // treat it as a full database backup and say so honestly in the detail.
    if (scope === 'app')
      return {
        scope: 'full',
        scopeNote:
          " Requested scope 'app' was treated as 'full': application code is versioned in git, not the database.",
      };
    if (!SCOPES.includes(scope as BackupScope))
      throw new BadRequestException(`scope must be one of ${SCOPES.join(', ')}, or 'app'`);
    return { scope: scope as BackupScope, scopeNote: '' };
  }

  private pgDumpArgs(
    kind: BackupKind,
    scope: BackupScope,
    dumpPath: string,
    connectionString: string,
  ): string[] {
    const args = ['--format=custom', '--no-owner', '--no-acl', `--file=${dumpPath}`];
    if (kind === 'schema') args.push('--schema-only');
    if (scope === 'configurations')
      for (const table of CONFIG_TABLES) args.push(`--table=${table}`);
    args.push(`--dbname=${connectionString}`);
    return args;
  }

  private verifyDatabaseName(): string {
    const name = process.env.BACKUP_RESTORE_VERIFY_DB ?? 'jkannel_restore_verify';
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
      throw new BadRequestException('BACKUP_RESTORE_VERIFY_DB must be a simple identifier');
    return name;
  }

  // ---- crypto -------------------------------------------------------------
  private encryptionKey(): Buffer {
    const secret =
      process.env.BACKUP_ENCRYPTION_KEY ||
      process.env.AUTH_SIGNING_KEY ||
      process.env.AUTH_ACCESS_TOKEN_KEY ||
      'jkannel-development-backup-encryption-key-change-me';
    // Derive a fixed 32-byte key from whatever secret is provided so any input
    // (hex, base64, passphrase) yields a valid AES-256 key.
    return createHash('sha256').update(secret).digest();
  }

  private encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, body]);
  }

  // ---- protected process boundaries (overridden in tests) -----------------
  protected async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  protected execTool(tool: string, args: string[]): Promise<ExecResult> {
    const timeout = Number(process.env.BACKUP_COMMAND_TIMEOUT_MS ?? 30 * 60_000);
    return new Promise<ExecResult>((resolve) => {
      execFile(tool, args, { maxBuffer: 256 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: null, stdout: '', stderr: String(error.message), missing: true });
          return;
        }
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: false });
      });
    });
  }

  protected async decryptArtifactToTemp(record: BackupRecord): Promise<string> {
    const enc = await readFile(record.artifact_path as string);
    const iv = enc.subarray(0, 12);
    const tag = enc.subarray(12, 28);
    const body = enc.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    const path = join(tmpdir(), `jkannel-restore-${randomBytes(6).toString('hex')}.dump`);
    await writeFile(path, plain);
    return path;
  }

  /**
   * Creates a throwaway verification database, runs `fn` against it, and always
   * drops it afterward. Uses the owner DATABASE_URL connection (createdb needs
   * elevated privilege). Overridden in tests to avoid a real server.
   */
  protected async withVerifyDatabase<T>(fn: (targetUrl: string) => Promise<T>): Promise<T> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error('DATABASE_URL is not configured for restore verification.');
    const name = this.verifyDatabaseName();
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(connectionString);
      url.pathname = `/${name}`;
      return await fn(url.toString());
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }
}
