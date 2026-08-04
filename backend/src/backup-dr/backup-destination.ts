import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Pluggable offsite destination for backup artifacts.
 *
 * G17's finding was that backups never leave the host: the service wrote
 * `file://${BACKUP_DIR}` and nothing else, so losing the host loses the
 * backups too. A real S3/Azure/SFTP client would mean a new dependency, which
 * this change deliberately does not add. Instead the seam is defined here with
 * a working filesystem implementation (which is genuinely useful: point
 * BACKUP_OFFSITE_DIR at an NFS/CIFS mount, an attached volume, or a
 * rclone/s3fs FUSE mount and artifacts really do leave the host).
 *
 * ---------------------------------------------------------------------------
 * ADDING A REMOTE DESTINATION
 * ---------------------------------------------------------------------------
 * 1. Add the client dependency (e.g. `@aws-sdk/client-s3`) to
 *    backend/package.json.
 * 2. Create `backend/src/backup-dr/destinations/s3.destination.ts` exporting a
 *    class implementing {@link BackupDestination}:
 *
 *      export class S3Destination implements BackupDestination {
 *        readonly id = 's3';
 *        describe() { return `s3://${this.bucket}/${this.prefix}`; }
 *        async put(localPath, remoteName) {
 *          // upload, then return { uri: `s3://${bucket}/${key}`, bytes }
 *        }
 *        async remove(uri) { /* DeleteObject *\/ }
 *      }
 *
 * 3. Register it in {@link resolveDestination} under a new BACKUP_DESTINATION
 *    value ('s3'), reading its configuration from env exactly as the local one
 *    does.
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
 * An unknown BACKUP_DESTINATION throws rather than silently degrading to local:
 * an operator who asked for S3 must not get a file copy and a green tick.
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
  throw new Error(
    `BACKUP_DESTINATION='${configured}' is not implemented in this build. ` +
      "Supported values: 'local' (filesystem/mount, set BACKUP_OFFSITE_DIR) or 'none'. " +
      'See backend/src/backup-dr/backup-destination.ts for how to add a remote destination.',
  );
}

/** The reason string recorded on a backup that has no offsite copy. */
export const NO_OFFSITE_WARNING =
  'No offsite destination is configured (set BACKUP_OFFSITE_DIR or BACKUP_DESTINATION): ' +
  'this artifact exists only on the backup host and will not survive its loss.';
