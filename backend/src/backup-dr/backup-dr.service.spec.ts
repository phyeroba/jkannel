import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupDrService, retentionCutoff, RETENTION_WINDOWS_MS } from './backup-dr.service';
import { BackupRecord } from './backup-dr.repository';
import { BackupDestination } from './backup-destination';
import { ConfigCaptureResult } from './config-capture';

/** A key strong enough to satisfy the mandatory-key check. */
const TEST_ENCRYPTION_KEY = 'unit-test-backup-encryption-key-0123456789';

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** Test double exposing overridable process boundaries. */
class TestService extends BackupDrService {
  public exec: (tool: string, args: string[]) => Promise<ExecResult> = async () => ({
    code: 0,
    stdout: '',
    stderr: '',
    missing: false,
  });
  public decryptedPath = '/tmp/fake-decrypted.dump';
  /** Deterministic configuration capture: the host's real /etc is never read. */
  public capture: ConfigCaptureResult = {
    bundle: null,
    files: 0,
    bytes: 0,
    checksum: null,
    missingRoots: ['/etc/kannel'],
    capturedRoots: [],
    notes: [],
  };
  public destination: BackupDestination | null = null;
  public destinationError: Error | null = null;

  protected execTool(tool: string, args: string[]): Promise<ExecResult> {
    return this.exec(tool, args);
  }
  protected async decryptArtifactToTemp(): Promise<string> {
    return this.decryptedPath;
  }
  protected async withVerifyDatabase<T>(fn: (targetUrl: string) => Promise<T>): Promise<T> {
    return fn('postgresql://verify/target');
  }
  protected async captureConfig(): Promise<ConfigCaptureResult> {
    return this.capture;
  }
  protected resolveDestination(): BackupDestination | null {
    if (this.destinationError) throw this.destinationError;
    return this.destination;
  }
}

const baseRecord = (over: Partial<BackupRecord> = {}): BackupRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  label: 'nightly',
  kind: 'full',
  scope: 'full',
  status: 'running',
  size_bytes: null,
  checksum: null,
  location: null,
  encrypted: true,
  detail: null,
  retention_class: 'daily',
  verified_at: null,
  artifact_path: '/var/lib/jkannel/backups/nightly.dump.enc',
  platform_version: '0.1.0',
  database_version: 'PostgreSQL 17',
  started_at: new Date().toISOString(),
  completed_at: null,
  created_by: 'op',
  config_artifact_path: null,
  config_artifact_checksum: null,
  config_file_count: 0,
  config_bytes: 0,
  offsite_location: null,
  offsite_synced_at: null,
  warning: null,
  ...over,
});

const actor = { tenantId: '1', userId: 'op' };

describe('retention math', () => {
  it('computes cutoffs for bounded classes and null for permanent classes', () => {
    const now = new Date('2026-07-10T00:00:00.000Z');
    expect(retentionCutoff('hourly', now)!.toISOString()).toBe('2026-07-08T00:00:00.000Z'); // -48h
    expect(retentionCutoff('daily', now)!.getTime()).toBe(
      now.getTime() - RETENTION_WINDOWS_MS.daily!,
    );
    expect(retentionCutoff('yearly', now)).toBeNull();
    expect(retentionCutoff('manual', now)).toBeNull();
  });
});

describe('BackupDrService.createBackup', () => {
  const originalDir = process.env.BACKUP_DIR;
  const originalUrl = process.env.DATABASE_URL;
  const originalKey = process.env.BACKUP_ENCRYPTION_KEY;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jk-backup-'));
    process.env.BACKUP_DIR = dir;
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/jkannel';
    process.env.BACKUP_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.BACKUP_DIR = originalDir;
    process.env.DATABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = originalKey;
  });

  it('records an honest failure when pg_dump is not installed', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'failed' })),
      completeBackup: jest.fn(),
    };
    const service = new TestService(repository);
    service.exec = async () => ({ code: null, stdout: '', stderr: 'ENOENT', missing: true });

    const result = await service.createBackup(actor, { kind: 'full', retentionClass: 'daily' });
    expect(result.status).toBe('failed');
    expect(repository.completeBackup).not.toHaveBeenCalled();
    expect(repository.failBackup).toHaveBeenCalledWith(
      actor,
      baseRecord().id,
      'pg_dump not available in this image',
    );
  });

  it('produces a real encrypted artifact and records size + checksum on success', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    // Simulate pg_dump by writing a dump file at the --file target.
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP-fake-custom-archive-bytes'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    const result = await service.createBackup(actor, { retentionClass: 'daily' });
    expect(result.status).toBe('completed');
    expect(repository.failBackup).not.toHaveBeenCalled();
    const call = repository.completeBackup.mock.calls[0][2];
    expect(call.sizeBytes).toBe('PGDMP-fake-custom-archive-bytes'.length);
    expect(call.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(call.location).toMatch(/^file:\/\//);
  });

  it('rejects an unknown backup kind', async () => {
    const service = new TestService({} as any);
    await expect(service.createBackup(actor, { kind: 'bogus' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown backup scope', async () => {
    const service = new TestService({} as any);
    await expect(service.createBackup(actor, { scope: 'bogus' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('runs a config-only pg_dump for scope=configurations and records the scope', async () => {
    const captured: string[][] = [];
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord({ scope: 'configurations' })),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.exec = async (_tool, args) => {
      captured.push(args);
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP-config-only'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, { scope: 'configurations', retentionClass: 'manual' });
    expect(repository.insertRunning.mock.calls[0][1].scope).toBe('configurations');
    const dumpArgs = captured[0];
    expect(dumpArgs).toEqual(
      expect.arrayContaining([
        '--table=configuration_versions',
        '--table=smsc_definitions',
        '--table=routing_rules',
        '--table=system_settings',
      ]),
    );
  });

  // ---- G17 hardening ------------------------------------------------------
  it('refuses to back up when BACKUP_ENCRYPTION_KEY is missing, instead of falling back', async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    process.env.AUTH_SIGNING_KEY = 'the-jwt-key-that-must-not-be-reused-as-a-backup-kek';
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'failed' })),
      completeBackup: jest.fn(),
    };
    const service = new TestService(repository);
    const pgDump = jest.fn();
    service.exec = pgDump as any;

    const result = await service.createBackup(actor, { retentionClass: 'daily' });
    expect(result.status).toBe('failed');
    // No dump was even attempted: the key is checked before doing any work.
    expect(pgDump).not.toHaveBeenCalled();
    expect(repository.completeBackup).not.toHaveBeenCalled();
    expect(repository.failBackup.mock.calls[0][2]).toMatch(
      /BACKUP_ENCRYPTION_KEY is not configured/,
    );
    delete process.env.AUTH_SIGNING_KEY;
  });

  it('refuses a known placeholder encryption key', async () => {
    process.env.BACKUP_ENCRYPTION_KEY = 'jkannel-development-backup-encryption-key-change-me';
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'failed' })),
      completeBackup: jest.fn(),
    };
    const service = new TestService(repository);
    const result = await service.createBackup(actor, {});
    expect(result.status).toBe('failed');
    expect(repository.failBackup.mock.calls[0][2]).toMatch(/known placeholder/);
  });

  it("records kind='incremental' as 'full' and says so, rather than mislabelling a full dump", async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP-full-not-incremental'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, { kind: 'incremental', retentionClass: 'daily' });
    // The catalog row is honest about what the artifact actually is.
    expect(repository.insertRunning.mock.calls[0][1].kind).toBe('full');
    expect(repository.completeBackup.mock.calls[0][2].detail).toMatch(
      /Requested kind 'incremental' was recorded as 'full'/,
    );
    expect(repository.completeBackup.mock.calls[0][2].detail).toMatch(/WAL archiving/);
  });

  it('warns loudly when no configuration was captured and no offsite destination exists', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, {});
    const call = repository.completeBackup.mock.calls[0][2];
    expect(call.warning).toMatch(/No configuration or certificate files were captured/);
    expect(call.warning).toMatch(/No offsite destination is configured/);
    expect(call.offsiteLocation).toBeNull();
    expect(call.offsiteSynced).toBe(false);
  });

  it('captures configuration alongside the dump and replicates both offsite', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.capture = {
      bundle: Buffer.from('gzipped-config-bundle'),
      files: 3,
      bytes: 900,
      checksum: 'c'.repeat(64),
      missingRoots: [],
      capturedRoots: ['/etc/kannel'],
      notes: [],
    };
    const stored: string[] = [];
    service.destination = {
      id: 'local',
      describe: () => 'file:///mnt/offsite',
      put: async (localPath) => {
        stored.push(localPath);
        return { uri: `file:///mnt/offsite/${stored.length}`, bytes: 10 };
      },
      remove: async () => undefined,
    };
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, {});
    const call = repository.completeBackup.mock.calls[0][2];
    expect(call.configFileCount).toBe(3);
    expect(call.configArtifactPath).toMatch(/\.config\.json\.gz\.enc$/);
    expect(call.configArtifactChecksum).toBe('c'.repeat(64));
    expect(call.offsiteSynced).toBe(true);
    expect(call.offsiteLocation).toMatch(/^file:\/\/\/mnt\/offsite\//);
    expect(call.warning).toBeNull();
    // Both the database dump and the configuration bundle went offsite.
    expect(stored).toHaveLength(2);
  });

  it('records a warning (never a silent success) when offsite replication fails', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.destination = {
      id: 'local',
      describe: () => 'file:///mnt/offsite',
      put: async () => {
        throw new Error('mount is read-only');
      },
      remove: async () => undefined,
    };
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, {});
    const call = repository.completeBackup.mock.calls[0][2];
    expect(call.offsiteSynced).toBe(false);
    expect(call.warning).toMatch(/Offsite replication to file:\/\/\/mnt\/offsite failed/);
  });

  it('fails the backup when the configured destination is not implemented', async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'failed' })),
      completeBackup: jest.fn(),
    };
    const service = new TestService(repository);
    service.destinationError = new Error(
      "BACKUP_DESTINATION='s3' is not implemented in this build.",
    );

    const result = await service.createBackup(actor, {});
    expect(result.status).toBe('failed');
    expect(repository.completeBackup).not.toHaveBeenCalled();
    expect(repository.failBackup.mock.calls[0][2]).toMatch(/not implemented/);
  });

  it("treats scope='app' as a full database backup", async () => {
    const repository: any = {
      databaseVersion: jest.fn().mockResolvedValue('PostgreSQL 17'),
      insertRunning: jest.fn().mockResolvedValue(baseRecord()),
      failBackup: jest.fn(),
      completeBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
    };
    const service = new TestService(repository);
    service.exec = async (_tool, args) => {
      const fileArg = args.find((a) => a.startsWith('--file='))!.slice('--file='.length);
      writeFileSync(fileArg, Buffer.from('PGDMP-full'));
      return { code: 0, stdout: '', stderr: '', missing: false };
    };

    await service.createBackup(actor, { scope: 'app' });
    expect(repository.insertRunning.mock.calls[0][1].scope).toBe('full');
    expect(repository.completeBackup.mock.calls[0][2].detail).toMatch(/treated as 'full'/);
  });
});

describe('BackupDrService.verifyBackup', () => {
  it('records an honest failure when pg_restore is not installed', async () => {
    const repository: any = {
      getBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
      markVerified: jest.fn(),
      markVerifyFailed: jest.fn().mockResolvedValue(baseRecord()),
    };
    const service = new TestService(repository);
    service.exec = async () => ({ code: null, stdout: '', stderr: 'ENOENT', missing: true });

    await service.verifyBackup(actor, baseRecord().id);
    expect(repository.markVerified).not.toHaveBeenCalled();
    expect(repository.markVerifyFailed).toHaveBeenCalledWith(
      actor,
      baseRecord().id,
      'pg_restore not available in this image',
    );
  });

  it('marks verified when pg_restore --list succeeds', async () => {
    const repository: any = {
      getBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
      markVerified: jest.fn().mockResolvedValue(baseRecord({ status: 'verified' })),
      markVerifyFailed: jest.fn(),
    };
    const service = new TestService(repository);
    service.exec = async () => ({
      code: 0,
      stdout: ';\n2200; TABLE messages\n2201; TABLE routes\n',
      stderr: '',
      missing: false,
    });

    const result = await service.verifyBackup(actor, baseRecord().id);
    expect(result.status).toBe('verified');
    expect(repository.markVerified).toHaveBeenCalled();
  });
});

describe('BackupDrService.restoreBackup', () => {
  it('refuses without confirm === true', async () => {
    const service = new TestService({} as any);
    await expect(
      service.restoreBackup(actor, baseRecord().id, { reason: 'drill', confirm: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a reason even when confirmed', async () => {
    const service = new TestService({} as any);
    await expect(
      service.restoreBackup(actor, baseRecord().id, { confirm: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('restore-verifies into an isolated database and records the run', async () => {
    const repository: any = {
      getBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
      recordRestoreRunning: jest.fn().mockResolvedValue({ id: 'op-1' }),
      completeRestore: jest
        .fn()
        .mockImplementation((_a, _id, v) => Promise.resolve({ id: 'op-1', ...v, target: null })),
    };
    const service = new TestService(repository);
    service.exec = async () => ({ code: 0, stdout: '', stderr: '', missing: false });

    const result = await service.restoreBackup(actor, baseRecord().id, {
      reason: 'quarterly DR drill',
      confirm: true,
    });
    expect(result.status).toBe('succeeded');
    expect(repository.recordRestoreRunning).toHaveBeenCalled();
  });

  it('records an honest failure when pg_restore is missing during restore', async () => {
    const repository: any = {
      getBackup: jest.fn().mockResolvedValue(baseRecord({ status: 'completed' })),
      recordRestoreRunning: jest.fn().mockResolvedValue({ id: 'op-1' }),
      completeRestore: jest
        .fn()
        .mockImplementation((_a, _id, v) => Promise.resolve({ id: 'op-1', ...v, target: null })),
    };
    const service = new TestService(repository);
    service.exec = async () => ({ code: null, stdout: '', stderr: 'ENOENT', missing: true });

    const result = await service.restoreBackup(actor, baseRecord().id, {
      reason: 'drill',
      confirm: true,
    });
    expect(result.status).toBe('failed');
    expect(repository.completeRestore).toHaveBeenCalledWith(actor, 'op-1', {
      status: 'failed',
      detail: 'pg_restore not available in this image',
    });
  });
});

describe('BackupDrService.applyRetention', () => {
  it('expires bounded classes and never touches yearly/manual', async () => {
    const expired: Record<string, number> = {};
    const repository: any = {
      expireBackups: jest.fn().mockImplementation((_a, retentionClass) => {
        expired[retentionClass] = (expired[retentionClass] ?? 0) + 1;
        return Promise.resolve([]); // no artifacts on disk to remove
      }),
    };
    const service = new TestService(repository);

    const summary = await service.applyRetention(actor);
    const classes = summary.map((s) => s.retentionClass);
    expect(classes).toEqual(['hourly', 'daily', 'weekly', 'monthly']);
    expect(expired.yearly).toBeUndefined();
    expect(expired.manual).toBeUndefined();
  });
});
