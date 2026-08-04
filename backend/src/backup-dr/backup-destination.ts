import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Pluggable offsite destination for backup artifacts.
 *
 * G17's finding was that backups never leave the host: the service wrote
 * `file://${BACKUP_DIR}` and nothing else, so losing the host loses the
 * backups too.
 *
 * Two drivers ship:
 *
 *   - `local` — a filesystem copy into BACKUP_OFFSITE_DIR. Genuinely useful
 *     when that path is an NFS/CIFS mount, an attached volume or an
 *     rclone/s3fs FUSE mount, but a plain local directory does NOT survive
 *     host loss, so it is not the default and never inferred silently.
 *   - `s3` — a real S3-compatible remote (AWS S3, MinIO, Ceph RGW, R2, ...),
 *     implemented in `s3.destination.ts` with SigV4 over `node:crypto` +
 *     `fetch`, i.e. with no new dependency.
 *
 * ---------------------------------------------------------------------------
 * ADDING ANOTHER REMOTE DESTINATION (Azure Blob, SFTP, ...)
 * ---------------------------------------------------------------------------
 * 1. Create `backend/src/backup-dr/<name>.destination.ts` exporting a class
 *    implementing {@link BackupDestination}. Follow `S3Destination`: it must
 *    VERIFY the stored object (size or digest) before returning, because a
 *    returned URI is what the backup record reports as durable.
 * 2. Register it in {@link resolveDestination} under a new BACKUP_DESTINATION
 *    value, reading its configuration from env and THROWING on anything
 *    missing.
 *
 * Nothing else changes: BackupDrService only ever talks to this interface, and
 * retention deletion already routes through `remove()`.
 * ---------------------------------------------------------------------------
 */
export interface BackupDestination {
  /** Stable identifier recorded on the backup row, e.g. 'local'. */
  readonly id: string;
  /** Human-readable target, safe to show an operator (never a secret). */
  describe(): string;
  /**
   * Replicates a local artifact to the destination.
   * Returns the canonical URI of the stored copy and its byte count.
   */
  put(localPath: string, remoteName: string): Promise<{ uri: string; bytes: number }>;
  /** Removes a previously stored artifact. Must not throw when already gone. */
  remove(uri: string): Promise<void>;
}

/**
 * Filesystem destination. Copies artifacts into BACKUP_OFFSITE_DIR, which is
 * expected to be a mount that survives loss of this host.
 */
export class LocalFilesystemDestination implements BackupDestination {
  readonly id = 'local';

  constructor(private readonly root: string) {}

  describe(): string {
    return `file://${this.root}`;
  }

  async put(localPath: string, remoteName: string): Promise<{ uri: string; bytes: number }> {
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, basename(remoteName));
    await copyFile(localPath, target);
    const info = await stat(target);
    return { uri: `file://${target}`, bytes: info.size };
  }

  async remove(uri: string): Promise<void> {
    const path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/**
 * Resolves the configured offsite destination.
 *
 * Returns null when none is configured — the caller must then record a WARNING
 * on the backup, never treat a host-local-only artifact as an offsite copy.
 * An unknown or half-configured BACKUP_DESTINATION throws rather than silently
 * degrading to local: an operator who asked for S3 must not get a file copy and
 * a green tick.
 */
export function resolveDestination(env: NodeJS.ProcessEnv = process.env): BackupDestination | null {
  const configured = (env.BACKUP_DESTINATION ?? '').trim().toLowerCase();
  const offsiteDir = (env.BACKUP_OFFSITE_DIR ?? '').trim();

  if (!configured) return offsiteDir ? new LocalFilesystemDestination(offsiteDir) : null;
  if (configured === 'none') return null;
  if (configured === 'local' || configured === 'file') {
    if (!offsiteDir)
      throw new Error(
        "BACKUP_DESTINATION='local' requires BACKUP_OFFSITE_DIR to point at an off-host mount.",
      );
    return new LocalFilesystemDestination(offsiteDir);
  }
  if (configured === 's3' || configured === 'minio') {
    // Deferred require: keeps the S3 driver (and its crypto/fetch plumbing) out
    // of the module graph for deployments that do not use it, and keeps this
    // file free of an import cycle (s3.destination imports BackupDestination).
    const { s3DestinationFromEnv } =
      require('./s3.destination') as typeof import('./s3.destination');
    return s3DestinationFromEnv(env);
  }
  throw new Error(
    `BACKUP_DESTINATION='${configured}' is not implemented in this build. ` +
      "Supported values: 's3' (any S3-compatible endpoint, incl. MinIO), " +
      "'local' (filesystem/mount, set BACKUP_OFFSITE_DIR) or 'none'. " +
      'See backend/src/backup-dr/backup-destination.ts for how to add a remote destination.',
  );
}

/** The reason string recorded on a backup that has no offsite copy. */
export const NO_OFFSITE_WARNING =
  'No offsite destination is configured (set BACKUP_OFFSITE_DIR or BACKUP_DESTINATION): ' +
  'this artifact exists only on the backup host and will not survive its loss.';
