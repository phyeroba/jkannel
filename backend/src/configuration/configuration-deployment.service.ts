import { BadGatewayException, Injectable } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

@Injectable()
export class ConfigurationDeploymentService {
  private readonly target = process.env.KAMEX_CONFIG_PATH ?? '/var/lib/jkannel/kamex.conf';
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
    if (!health.ok && health.status !== 503)
      throw new Error(`Kamex health verification failed (${health.status})`);
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
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.target);
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
        await writeFile(temporary, previous, { mode: 0o600 });
        await rename(temporary, this.target);
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
