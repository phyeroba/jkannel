import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  captureConfiguration,
  captureWarning,
  configuredCapturePaths,
  DEFAULT_CONFIG_PATHS,
} from './config-capture';

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return overrides;
}

describe('configuredCapturePaths', () => {
  it('uses the defaults when BACKUP_CONFIG_PATHS is unset', () => {
    expect(configuredCapturePaths(env({}))).toEqual(DEFAULT_CONFIG_PATHS);
  });

  it('splits a configured list and drops relative entries', () => {
    expect(
      configuredCapturePaths(env({ BACKUP_CONFIG_PATHS: '/etc/kannel,relative/path,/etc/ssl' })),
    ).toEqual(['/etc/kannel', '/etc/ssl']);
  });

  it('captures nothing when explicitly set to empty', () => {
    expect(configuredCapturePaths(env({ BACKUP_CONFIG_PATHS: '' }))).toEqual([]);
  });
});

describe('captureConfiguration', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jk-config-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captures files recursively with per-file checksums', async () => {
    mkdirSync(join(root, 'certs'), { recursive: true });
    writeFileSync(join(root, 'kannel.conf'), 'group = core\nadmin-port = 13000\n');
    writeFileSync(join(root, 'certs', 'server.pem'), '-----BEGIN CERTIFICATE-----');

    const result = await captureConfiguration(env({ BACKUP_CONFIG_PATHS: root }));
    expect(result.files).toBe(2);
    expect(result.bundle).not.toBeNull();
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.capturedRoots).toEqual([root]);

    const bundle = JSON.parse(gunzipSync(result.bundle!).toString('utf8'));
    expect(bundle.format).toBe('jkannel-config-bundle/1');
    const paths = bundle.files.map((file: any) => file.path).sort();
    expect(paths[0]).toMatch(/certs\/server\.pem$/);
    const conf = bundle.files.find((file: any) => file.path.endsWith('kannel.conf'));
    expect(Buffer.from(conf.content, 'base64').toString()).toContain('admin-port = 13000');
    expect(conf.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports roots that do not exist rather than silently skipping them', async () => {
    const result = await captureConfiguration(env({ BACKUP_CONFIG_PATHS: join(root, 'nope') }));
    expect(result.files).toBe(0);
    expect(result.bundle).toBeNull();
    expect(result.missingRoots).toEqual([join(root, 'nope')]);
  });

  it('skips files above the per-file cap and records why', async () => {
    writeFileSync(join(root, 'big.conf'), Buffer.alloc(4096, 0x61));
    writeFileSync(join(root, 'small.conf'), 'ok');
    const result = await captureConfiguration(
      env({ BACKUP_CONFIG_PATHS: root, BACKUP_CONFIG_MAX_FILE_BYTES: '100' }),
    );
    expect(result.files).toBe(1);
    expect(result.notes.join(' ')).toMatch(/exceeds the 100-byte per-file cap/);
  });

  it('ignores log and archive noise', async () => {
    writeFileSync(join(root, 'kannel.conf'), 'group = core');
    writeFileSync(join(root, 'bearerbox.log'), 'chatter');
    writeFileSync(join(root, 'old.tar'), 'blob');
    const result = await captureConfiguration(env({ BACKUP_CONFIG_PATHS: root }));
    expect(result.files).toBe(1);
  });

  it('honours the file-count cap', async () => {
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${index}.conf`), 'x');
    const result = await captureConfiguration(
      env({ BACKUP_CONFIG_PATHS: root, BACKUP_CONFIG_MAX_FILES: '2' }),
    );
    expect(result.files).toBe(2);
    expect(result.notes.join(' ')).toMatch(/File limit 2 reached/);
  });
});

describe('captureWarning', () => {
  it('warns loudly when nothing was captured', () => {
    const warning = captureWarning({
      bundle: null,
      files: 0,
      bytes: 0,
      checksum: null,
      missingRoots: ['/etc/kannel'],
      capturedRoots: [],
      notes: [],
    });
    expect(warning).toMatch(/restores the database only/);
    expect(warning).toMatch(/\/etc\/kannel/);
  });

  it('is silent when configuration was captured', () => {
    expect(
      captureWarning({
        bundle: Buffer.from('x'),
        files: 2,
        bytes: 10,
        checksum: 'a'.repeat(64),
        missingRoots: [],
        capturedRoots: ['/etc/kannel'],
        notes: [],
      }),
    ).toBeNull();
  });
});
