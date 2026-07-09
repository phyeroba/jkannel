import { Injectable } from '@nestjs/common';
import { connect } from 'node:net';

@Injectable()
export class SmscConnectivityService {
  test(
    host: string,
    port: number,
    timeoutMs = 3000,
  ): Promise<{ reachable: boolean; latencyMs: number; detail: string }> {
    return new Promise((resolve) => {
      const started = Date.now();
      let settled = false;
      const finish = (reachable: boolean, detail: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ reachable, latencyMs: Date.now() - started, detail });
      };
      const socket = connect({ host, port });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true, 'TCP connection established'));
      socket.once('timeout', () => finish(false, 'Connection timed out'));
      socket.once('error', (error) => finish(false, error.message));
    });
  }
}
