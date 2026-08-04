import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemDestination, resolveDestination } from './backup-destination';

describe('resolveDestination', () => {
  it('returns null when nothing is configured (caller must warn, not pretend)', () => {
    expect(resolveDestination({})).toBeNull();
  });

  it("returns null for an explicit 'none'", () => {
    expect(resolveDestination({ BACKUP_DESTINATION: 'none' })).toBeNull();
  });

  it('infers the local destination from BACKUP_OFFSITE_DIR alone', () => {
    const destination = resolveDestination({
      BACKUP_OFFSITE_DIR: '/mnt/offsite',
    });
    expect(destination?.id).toBe('local');
    expect(destination?.describe()).toBe('file:///mnt/offsite');
  });

  it("requires an offsite directory when BACKUP_DESTINATION='local'", () => {
    expect(() => resolveDestination({ BACKUP_DESTINATION: 'local' })).toThrow(
      /requires BACKUP_OFFSITE_DIR/,
    );
  });

  /**
   * An operator who configured a destination this build cannot reach must NOT
   * silently get a local file copy and a green tick; that would be a backup
   * reporting a durability it does not have.
   */
  it('throws for an unimplemented remote destination rather than degrading to local', () => {
    expect(() =>
      resolveDestination({
        BACKUP_DESTINATION: 'azure-blob',
        BACKUP_OFFSITE_DIR: '/mnt/offsite',
      }),
    ).toThrow(/'azure-blob' is not implemented in this build/);
  });

  it('builds the S3 destination when it is fully configured', () => {
    const destination = resolveDestination({
      BACKUP_DESTINATION: 's3',
      BACKUP_S3_BUCKET: 'jkannel-backups',
      BACKUP_S3_REGION: 'eu-west-1',
      BACKUP_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
      BACKUP_S3_PREFIX: 'prod/',
    });
    expect(destination?.id).toBe('s3');
    expect(destination?.describe()).toContain('s3://jkannel-backups/prod');
    // Never leaks the secret into an operator-facing string.
    expect(destination?.describe()).not.toContain('secret');
  });

  it("accepts 'minio' as an alias for the S3 driver", () => {
    const destination = resolveDestination({
      BACKUP_DESTINATION: 'minio',
      BACKUP_S3_BUCKET: 'b',
      BACKUP_S3_ENDPOINT: 'http://minio:9000',
      BACKUP_S3_ACCESS_KEY_ID: 'k',
      BACKUP_S3_SECRET_ACCESS_KEY: 's',
    });
    expect(destination?.id).toBe('s3');
    expect(destination?.describe()).toContain('http://minio:9000');
  });

  /**
   * Half-configured S3 is the dangerous case: without this it would either
   * throw somewhere deep in the upload or, worse, be papered over.
   */
  it('throws when S3 is selected but its credentials/bucket are missing', () => {
    expect(() => resolveDestination({ BACKUP_DESTINATION: 's3' })).toThrow(
      /requires BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY/,
    );
  });

  it('throws on a malformed S3 endpoint rather than guessing', () => {
    const withEndpoint = (BACKUP_S3_ENDPOINT: string) =>
      resolveDestination({
        BACKUP_DESTINATION: 's3',
        BACKUP_S3_BUCKET: 'b',
        BACKUP_S3_ACCESS_KEY_ID: 'k',
        BACKUP_S3_SECRET_ACCESS_KEY: 's',
        BACKUP_S3_ENDPOINT,
      });
    // 'minio:9000' parses as a URL, but with scheme 'minio:' — a classic
    // "forgot the https://" typo that must not be silently normalised.
    expect(() => withEndpoint('minio:9000')).toThrow(/must be http\(s\)/);
    expect(() => withEndpoint('not a url')).toThrow(/is not a valid absolute URL/);
  });
});

describe('LocalFilesystemDestination', () => {
  let root: string;
  let source: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jk-offsite-'));
    source = join(root, 'source.bin');
    writeFileSync(source, Buffer.from('encrypted-artifact-bytes'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('copies the artifact and reports its URI and size', async () => {
    const destination = new LocalFilesystemDestination(join(root, 'remote'));
    const stored = await destination.put(source, 'nightly.dump.enc');
    expect(stored.uri).toMatch(/nightly\.dump\.enc$/);
    expect(stored.bytes).toBe('encrypted-artifact-bytes'.length);
    expect(readFileSync(stored.uri.replace('file://', '')).toString()).toBe(
      'encrypted-artifact-bytes',
    );
  });

  it('removes a stored artifact and tolerates one that is already gone', async () => {
    const destination = new LocalFilesystemDestination(join(root, 'remote'));
    const stored = await destination.put(source, 'nightly.dump.enc');
    await destination.remove(stored.uri);
    await expect(destination.remove(stored.uri)).resolves.toBeUndefined();
  });
});
