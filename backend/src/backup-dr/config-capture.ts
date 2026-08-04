import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * On-disk configuration and certificate capture.
 *
 * G17: "Config, certificates, .env and compose files are never captured. After
 * a host loss you restore a database into an environment you must hand-rebuild."
 * A pg_dump alone cannot satisfy the spec's "Complete Server Loss" scenario,
 * so every backup now also captures the operator-authored files that make the
 * gateway what it is: kannel configuration, TLS material and the deployment's
 * environment files.
 *
 * The result is a single gzipped JSON bundle which the caller encrypts with the
 * same AES-256-GCM key as the database dump and stores as a companion artifact.
 * A JSON bundle (rather than tar) is deliberate: it needs no new dependency and
 * no external binary, it records a per-file SHA-256 so tampering is detectable,
 * and it can be read back by `node -e` during a recovery with nothing else
 * installed.
 *
 * Safety rails, because this reads secrets off disk:
 *   - only paths explicitly listed in BACKUP_CONFIG_PATHS (or the defaults) are
 *     read, and each entry is resolved and confirmed to stay inside its root
 *   - per-file and total byte caps stop a stray log directory from ballooning
 *     the artifact
 *   - files that are missing, unreadable or skipped are REPORTED, never
 *     silently omitted: a capture that got nothing must look like a problem
 */

export interface CapturedFile {
  /** Path relative to its configured root, prefixed by the root's label. */
  path: string;
  /** Absolute source path on the backup host. */
  source: string;
  bytes: number;
  sha256: string;
  /** Base64 of the file's raw bytes. */
  content: string;
}

export interface ConfigCaptureResult {
  /** Gzipped JSON bundle, ready to encrypt. Null when nothing was captured. */
  bundle: Buffer | null;
  files: number;
  bytes: number;
  /** sha256 of the uncompressed bundle JSON. */
  checksum: string | null;
  /** Roots that were configured but did not exist on this host. */
  missingRoots: string[];
  /** Roots that were configured and yielded at least one file. */
  capturedRoots: string[];
  /** Human-readable notes: skipped files, truncation, permission errors. */
  notes: string[];
}

/**
 * Default capture roots. Chosen to cover the three things a rebuild needs:
 * the Kannel/Kamex gateway configuration, the platform's own configuration and
 * environment, and TLS material.
 */
export const DEFAULT_CONFIG_PATHS = [
  '/etc/kannel',
  '/etc/kamex',
  '/etc/jkannel',
  '/etc/ssl/jkannel',
  '/opt/jkannel/config',
];

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 2_000;

/** Extensions/patterns never worth capturing (and often huge). */
const SKIP_PATTERN = /\.(log|gz|bz2|zip|tar|dump|sock|pid|swp)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'spool', 'tmp', 'cache']);

export function configuredCapturePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BACKUP_CONFIG_PATHS;
  if (raw === undefined) return DEFAULT_CONFIG_PATHS;
  // Comma or the platform's own PATH delimiter (':' on POSIX, ';' on Windows).
  // Splitting on ':' unconditionally would tear a Windows drive letter in half.
  return raw
    .split(new RegExp(`[,${delimiter === ':' ? ':' : ';'}]`))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
}

/**
 * Walks the configured roots and builds the bundle. Never throws: a failure to
 * read one path becomes a note, so a configuration problem degrades the backup
 * visibly instead of aborting it.
 */
export async function captureConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigCaptureResult> {
  const roots = configuredCapturePaths(env);
  const maxFileBytes = positiveInt(env.BACKUP_CONFIG_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = positiveInt(env.BACKUP_CONFIG_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES);
  const maxFiles = positiveInt(env.BACKUP_CONFIG_MAX_FILES, DEFAULT_MAX_FILES);

  const files: CapturedFile[] = [];
  const missingRoots: string[] = [];
  const capturedRoots: string[] = [];
  const notes: string[] = [];
  let bytes = 0;

  for (const root of roots) {
    const resolvedRoot = resolve(root);
    let rootStat;
    try {
      rootStat = await stat(resolvedRoot);
    } catch {
      missingRoots.push(root);
      continue;
    }
    const before = files.length;
    const targets = rootStat.isDirectory() ? await walk(resolvedRoot, notes) : [resolvedRoot];
    for (const target of targets) {
      if (files.length >= maxFiles) {
        notes.push(
          `File limit ${maxFiles} reached; remaining files under ${root} were not captured.`,
        );
        break;
      }
      // Defence in depth against a symlink pointing out of the root.
      const rel = relative(resolvedRoot, target);
      if (rootStat.isDirectory() && (rel.startsWith('..') || isAbsolute(rel))) {
        notes.push(`Skipped ${target}: resolves outside its configured root ${root}.`);
        continue;
      }
      let content: Buffer;
      try {
        const info = await stat(target);
        if (!info.isFile()) continue;
        if (info.size > maxFileBytes) {
          notes.push(
            `Skipped ${target}: ${info.size} bytes exceeds the ${maxFileBytes}-byte per-file cap.`,
          );
          continue;
        }
        if (bytes + info.size > maxTotalBytes) {
          notes.push(
            `Skipped ${target}: total capture would exceed the ${maxTotalBytes}-byte cap.`,
          );
          continue;
        }
        content = await readFile(target);
      } catch (error) {
        notes.push(`Could not read ${target}: ${(error as Error).message}`);
        continue;
      }
      bytes += content.length;
      files.push({
        path: rootStat.isDirectory()
          ? join(labelFor(root), rel).split(sep).join('/')
          : labelFor(root),
        source: target,
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        content: content.toString('base64'),
      });
    }
    if (files.length > before) capturedRoots.push(root);
  }

  if (!files.length)
    return {
      bundle: null,
      files: 0,
      bytes: 0,
      checksum: null,
      missingRoots,
      capturedRoots,
      notes,
    };

  const document = JSON.stringify({
    format: 'jkannel-config-bundle/1',
    createdAt: new Date().toISOString(),
    host: env.HOSTNAME ?? null,
    roots,
    missingRoots,
    notes,
    files,
  });
  return {
    bundle: gzipSync(Buffer.from(document, 'utf8')),
    files: files.length,
    bytes,
    checksum: createHash('sha256').update(document).digest('hex'),
    missingRoots,
    capturedRoots,
    notes,
  };
}

/** The warning recorded on a backup whose configuration capture found nothing. */
export function captureWarning(result: ConfigCaptureResult): string | null {
  if (result.files > 0) return null;
  return (
    'No configuration or certificate files were captured' +
    (result.missingRoots.length
      ? ` (none of ${result.missingRoots.join(', ')} exist on this host)`
      : '') +
    '. This backup restores the database only: gateway configuration and TLS material ' +
    'would have to be rebuilt by hand. Set BACKUP_CONFIG_PATHS to the directories that ' +
    'hold them.'
  );
}

async function walk(directory: string, notes: string[]): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    notes.push(`Could not list ${directory}: ${(error as Error).message}`);
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await walk(full, notes)));
    } else if (entry.isFile()) {
      if (SKIP_PATTERN.test(entry.name)) continue;
      found.push(full);
    }
    // Symlinks are intentionally not followed.
  }
  return found;
}

function labelFor(root: string): string {
  return (
    root
      .replace(/^[/\\]+/, '')
      .split(/[/\\]+/)
      .join('_') || 'root'
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
