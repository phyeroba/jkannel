import { BadGatewayException, Injectable } from '@nestjs/common';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

@Injectable()
export class ConfigurationDeploymentService {
  private readonly target = process.env.KAMEX_CONFIG_PATH ?? '/var/lib/jkannel/kamex.conf';

  /**
   * Writes `content` to `path` and does not return until it is durable.
   *
   * `writeFile` alone returns once the data is in the page cache. `rename` is
   * atomic against a concurrent READER, but it is not a barrier against power
   * loss: the rename can reach the disk while the file's contents have not,
   * leaving a correctly-named, truncated configuration. The engine's parser
   * panics on a malformed file and keeps panicking on every restart, so the
   * cost of that window is a gateway that will not boot until someone edits
   * the file by hand.
   *
   * The directory is synced as well as the file: the file's own fsync makes
   * its CONTENTS durable, but the directory entry created by `rename` is
   * separate metadata and needs its own barrier.
   */
  private async writeDurable(path: string, content: string | Buffer, mode: number) {
    const handle = await open(path, 'w', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** fsyncs a directory so a rename into it survives a crash. */
  private async syncDirectory(path: string) {
    let handle;
    try {
      handle = await open(path, 'r');
      await handle.sync();
    } catch {
      // Directory fsync is not portable — it fails with EISDIR/EPERM on some
      // platforms and filesystems (notably Windows, where developers run this).
      // The file's own sync has already happened by this point, so failing the
      // whole deployment over the weaker of the two barriers would trade a real
      // outage for a theoretical one.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  async validateNative(content: string) {
    const base = process.env.KAMEX_VALIDATOR_URL;
    const token = process.env.KAMEX_VALIDATOR_TOKEN;
    if (!base || !token) throw new BadGatewayException('Native Kamex validator is not configured');
    const response = await fetch(new URL('/validate', base), {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-validator-token': token },
      body: content,
      signal: AbortSignal.timeout(12000),
    });
    const result = (await response.json()) as { valid?: boolean; output?: string };
    if (!response.ok || !result.valid)
      throw new BadGatewayException({
        message: 'Native Kamex validation failed',
        validatorOutput: result.output?.slice(-4000),
      });
    return { valid: true, validator: 'kamex-bearerbox' };
  }
  private async reload() {
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_ADMIN_PASSWORD;
    if (!base || !password) return false;
    const url = new URL('/graceful-restart', base);
    url.searchParams.set('password', password);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Kamex rejected reload (${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(5000) });
    // Any non-2xx is UNHEALTHY. 503 in particular means bearerbox came back but
    // is not serving — exactly the state a bad configuration produces — so it
    // must trigger the rollback in deploy(), not be waved through.
    if (!health.ok)
      throw new Error(
        `Kamex health verification failed (${health.status}); the engine is not healthy ` +
          'after the reload',
      );
    return true;
  }
  async deploy(content: string) {
    await this.validateNative(content);
    const temporary = `${this.target}.${process.pid}.tmp`;
    await mkdir(dirname(this.target), { recursive: true });
    let previous: Buffer | undefined;
    try {
      previous = await readFile(this.target);
    } catch {
      /* first deployment */
    }
    await this.writeDurable(temporary, content, 0o600);
    await rename(temporary, this.target);
    await this.syncDirectory(dirname(this.target));
    try {
      const reloaded = await this.reload();
      return reloaded
        ? { written: true, reloaded: true, verified: true, nativeValidation: true }
        : {
            written: true,
            reloaded: false,
            verified: false,
            nativeValidation: true,
            message: 'Kamex reload endpoint is not configured',
          };
    } catch (error) {
      if (previous) {
        // The rollback path is the one that must NOT be best-effort: it runs
        // because a deployment already failed, so leaving a half-written
        // previous configuration behind would turn a failed deploy into a
        // gateway that cannot start.
        await this.writeDurable(temporary, previous, 0o600);
        await rename(temporary, this.target);
        await this.syncDirectory(dirname(this.target));
        try {
          await this.reload();
        } catch {
          /* preserve original deployment error */
        }
      }
      throw new BadGatewayException(`Kamex deployment rolled back: ${(error as Error).message}`);
    }
  }
}
