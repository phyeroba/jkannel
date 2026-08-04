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
   * An operator who configured S3 must NOT silently get a local file copy and a
   * green tick; that would be a backup reporting a durability it does not have.
   */
  it('throws for an unimplemented remote destination rather than degrading to local', () => {
    expect(() =>
      resolveDestination({
        BACKUP_DESTINATION: 's3',
        BACKUP_OFFSITE_DIR: '/mnt/offsite',
      }),
    ).toThrow(/'s3' is not implemented in this build/);
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
