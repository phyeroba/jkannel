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
  /**
   * The mode the engine's configuration is written with.
   *
   * NOT 0600, which is what this used to be and which stopped bearerbox from
   * starting at all. The API container writes the file as root; bearerbox runs
   * as an unprivileged user and mounts it read-only, so an owner-only file is
   * one its own process cannot open. It panics on `cfg_read` with
   * "System error 13: Permission denied" and the container then restarts
   * forever — and because the rollback path rewrites the previous CONTENT with
   * the same MODE, reverting did not rescue it either.
   *
   * That was invisible until a generated configuration was actually deployed to
   * a running engine for the first time. Every layer above worked: the file was
   * rendered correctly, a real bearerbox validated it in the validator
   * container, and it was written durably and atomically. The engine simply
   * could not read it.
   *
   * 0644 is right rather than merely convenient: this file contains NO secret
   * material. Credentials are rendered as `${ENV_NAME}` placeholders that the
   * engine resolves from its own environment — that is the whole point of the
   * secret-reference design — so the readable content is hostnames, ports and
   * tuning, which the engine user must read and which leak nothing.
   */
  private static readonly CONFIG_MODE = 0o644;

  private async writeDurable(path: string, content: string | Buffer, mode: number) {
    const handle = await open(path, 'w', mode);
    try {
      await handle.writeFile(content);
      // `open`'s mode argument is masked by the process umask, so a container
      // running with umask 077 would land on 0600 again and stop the engine
      // from reading its own configuration — the exact failure this mode was
      // widened to prevent, reintroduced silently by an environment variable
      // nobody set deliberately. `chmod` is not masked.
      await handle.chmod(mode);
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
  /**
   * How many boxes are attached to bearerbox right now.
   *
   * `/status.txt` lists them under "Box connections:", one per line. The COUNT
   * is what matters, not which is which: sqlbox attaches as an smsbox, so the
   * two are not reliably distinguishable from the outside, and "fewer boxes
   * than before" answers the question either way.
   */
  private async boxCount(base: string, password: string): Promise<number | null> {
    try {
      const url = new URL('/status.txt', base);
      url.searchParams.set('password', password);
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const text = await response.text();
      const section = text.split(/Box connections:/i)[1];
      if (section === undefined) return null;
      // Lines until the next unindented heading (e.g. "SMSC connections:").
      const lines = section.split(/\r?\n/).slice(1);
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!/^\s/.test(line)) break;
        count += 1;
      }
      return count;
    } catch {
      return null;
    }
  }

  private async reload() {
    const base = process.env.KAMEX_BASE_URL;
    const password = process.env.KAMEX_ADMIN_PASSWORD;
    if (!base || !password) return false;
    // Counted BEFORE the restart, because the whole point is the comparison.
    const boxesBefore = await this.boxCount(base, password);
    const url = new URL('/graceful-restart', base);
    url.searchParams.set('password', password);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Kamex rejected reload (${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(5000) });

    /*
     * "DID BEARERBOX COME BACK", NOT "IS EVERY CARRIER BOUND".
     *
     * This used to treat any non-2xx as a failed deployment, with the reasoning
     * that 503 means the engine came back and is not serving. That is not what
     * Kamex's 503 means. `/health` answers 503 whenever no SMSC is bound, and
     * reports `"status": "running"` alongside it — the process is up and
     * serving its admin port, it simply has no carrier link. It is a statement
     * about the CARRIERS, not about the engine.
     *
     * The consequence was that every deployment on a gateway with no bound
     * carrier rolled back and reported failure, and the operator was told their
     * configuration was bad when it had been rendered correctly, validated by a
     * real bearerbox and written successfully. Worse, it is unescapable at the
     * only moment it matters most: a gateway being configured for the FIRST
     * time has no carrier bound by definition, so the first deploy could never
     * succeed — which is a fair part of why a generated configuration had never
     * reached a live carrier.
     *
     * `docker-compose.yml` already learned this for the container healthcheck,
     * which accepts 200 or 503 and says why. The deploy path never got the same
     * fix, and the two disagreed about what "healthy" means.
     *
     * So: the process must be RUNNING. Unreachable, a non-503 error, or a body
     * that does not say running still fails and still rolls back — those are
     * what a configuration bad enough to stop bearerbox actually looks like.
     */
    const body = await health.text().catch(() => '');
    const running = /"status"\s*:\s*"running"/.test(body);
    if (!health.ok && !(health.status === 503 && running))
      throw new Error(
        `Kamex health verification failed (${health.status}); the engine is not running ` +
          'after the reload',
      );

    /*
     * DID EVERY BOX COME BACK? A graceful restart severs delivery silently.
     *
     * `graceful-restart` re-execs bearerbox, and SQLBox does not notice: it
     * keeps a socket that is no longer connected to anything and never
     * reconnects. Outbound then stops dead — every submission lands in
     * `send_sms` and stays there — while the deployment reports success,
     * bearerbox reports healthy, and every figure in the console stays green.
     *
     * Measured here, not theorised: after one deploy, 700 messages sat in
     * `send_sms`, SQLBox's last log line was from before the restart, and
     * restarting SQLBox drained all 700 into the engine at once.
     *
     * The handover already carried "never recreate bearerbox — SQLBox does not
     * reconnect". Nobody had connected that to the deploy path, which does the
     * same thing through a different door.
     *
     * REPORTED, NOT ROLLED BACK. The configuration is valid and deployed; the
     * problem is a box that has to reattach. Rolling back would reload again
     * and sever it a second time, so the rollback is the one response that
     * cannot help. What an operator needs is to be told, in the deploy result,
     * that delivery is down and that restarting SQLBox is the fix.
     */
    const boxesAfter = await this.boxCount(base, password);
    const boxesLost =
      boxesBefore !== null && boxesAfter !== null && boxesAfter < boxesBefore
        ? boxesBefore - boxesAfter
        : 0;
    return {
      reloaded: true,
      boxesBefore,
      boxesAfter,
      ...(boxesLost
        ? {
            warning:
              `${boxesLost} box connection(s) did not reattach after the engine restart. ` +
              'SQLBox does not reconnect on its own, so OUTBOUND DELIVERY HAS STOPPED — ' +
              'submissions will queue in send_sms with every other indicator green. ' +
              'Restart the SQLBox container to restore delivery. The configuration itself ' +
              'deployed successfully and is not the problem.',
          }
        : {}),
    };
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
    await this.writeDurable(temporary, content, ConfigurationDeploymentService.CONFIG_MODE);
    await rename(temporary, this.target);
    await this.syncDirectory(dirname(this.target));
    try {
      const reloaded = await this.reload();
      // `false` means the reload endpoint is not configured at all. An object
      // means the engine restarted, and carries how many boxes reattached —
      // plus a warning when fewer did, because that is delivery stopping
      // silently and the deploy result is the only place it will be noticed.
      return reloaded
        ? {
            written: true,
            verified: true,
            nativeValidation: true,
            ...reloaded,
          }
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
        await this.writeDurable(temporary, previous, ConfigurationDeploymentService.CONFIG_MODE);
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
