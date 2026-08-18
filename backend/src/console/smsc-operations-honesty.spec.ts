import { SmscController } from './console.controllers';

/**
 * The SMSC operations endpoint must record and return WHAT was verified, not
 * merely that something succeeded. Two defects this holds closed:
 *
 *  - `test` recorded a bare TCP connect as a passed connection test;
 *  - `reconnect` recorded success for a `start-smsc` that cycled nothing.
 */

const request: any = { principal: { tenantId: '7', userId: 'user-1', username: 'op' } };
const smscId = '11111111-1111-4111-8111-111111111111';

function makeController(smsc: Record<string, unknown>) {
  const completions: any[] = [];
  /** Arguments the controller passed to beginSmscOperation, for the reason test. */
  const beginArgs: unknown[][] = [];
  const repository: any = {
    beginSmscOperation: jest.fn(async (...args: unknown[]) => {
      beginArgs.push(args);
      return { id: 'dep-1', status: 'pending' };
    }),
    getSmsc: jest.fn(async () => ({ id: smscId, engine_id: 'carrier-a', ...smsc })),
    completeSmscOperation: jest.fn(
      async (
        _actor: unknown,
        _deploymentId: string,
        _smscId: string,
        operation: string,
        succeeded: boolean,
        detail: string,
        latencyMs?: number,
        verification?: string,
      ) => {
        const record = { operation, succeeded, detail, latencyMs, verification };
        completions.push(record);
        return { id: 'dep-1', status: succeeded ? 'succeeded' : 'failed', ...record };
      },
    ),
  };
  const connectivity: any = { verify: jest.fn() };
  const controlSmsc = jest.fn();
  const engines: any = { smscControl: () => ({ controlSmsc }) };
  const controller = new SmscController(repository, engines, connectivity);
  return { controller, repository, connectivity, controlSmsc, completions, beginArgs };
}

describe('test connection records the verification level', () => {
  it('records smpp_bind and passes when a real bind succeeded', async () => {
    const { controller, connectivity, completions } = makeController({ type: 'smpp' });
    connectivity.verify.mockResolvedValue({
      verified: 'smpp_bind',
      passed: true,
      reachable: true,
      bound: true,
      latencyMs: 31,
      detail: 'SMPP transceiver bind succeeded as "jkannel"',
      commandStatus: 0,
      commandStatusName: 'ESME_ROK',
    });

    const result: any = await controller.operate(request, smscId, 'test', 'key-1');

    expect(completions[0]).toMatchObject({
      operation: 'test',
      succeeded: true,
      verification: 'smpp_bind',
      latencyMs: 31,
    });
    // The caller is told the level too, not just "succeeded".
    expect(result.verification.verified).toBe('smpp_bind');
  });

  it('records a FAILED test when the socket opened but the bind was rejected', async () => {
    const { controller, connectivity, completions } = makeController({ type: 'smpp' });
    connectivity.verify.mockResolvedValue({
      verified: 'smpp_bind',
      passed: false,
      reachable: true,
      bound: false,
      latencyMs: 12,
      detail: 'SMPP bind rejected by the SMSC: ESME_RINVPASWD',
    });

    await controller.operate(request, smscId, 'test', 'key-1');

    // The old code called this a success because the TCP socket opened.
    expect(completions[0].succeeded).toBe(false);
    expect(completions[0].detail).toContain('ESME_RINVPASWD');
  });

  it('records tcp_socket, never smpp_bind, when only a socket was checked', async () => {
    const { controller, connectivity, completions } = makeController({ type: 'http' });
    connectivity.verify.mockResolvedValue({
      verified: 'tcp_socket',
      passed: true,
      reachable: true,
      bound: null,
      latencyMs: 5,
      detail: 'TCP socket to h:1 opened. This is NOT an SMPP bind — ...',
      bindSkippedReason: 'SMSC type "http" has no SMPP bind to verify',
    });

    const result: any = await controller.operate(request, smscId, 'test', 'key-1');

    expect(completions[0].verification).toBe('tcp_socket');
    expect(completions[0].detail).toContain('NOT an SMPP bind');
    expect(result.verification.bindSkippedReason).toContain('no SMPP bind to verify');
  });

  it('lets the connectivity service decide about a fake SMSC rather than short-circuiting', async () => {
    const { controller, connectivity, completions } = makeController({ type: 'fake' });
    connectivity.verify.mockResolvedValue({
      verified: 'not_applicable',
      passed: true,
      reachable: true,
      bound: null,
      latencyMs: 0,
      detail: 'Fake SMSC has no network endpoint; nothing was verified.',
    });

    await controller.operate(request, smscId, 'test', 'key-1');

    expect(connectivity.verify).toHaveBeenCalled();
    expect(completions[0].verification).toBe('not_applicable');
  });
});

describe('reconnect records whether the bind cycle was observed', () => {
  it('records bind_cycled when the adapter saw the drop and the recovery', async () => {
    const { controller, controlSmsc, completions } = makeController({ type: 'smpp' });
    controlSmsc.mockResolvedValue({
      operation: 'reconnect',
      engineId: 'carrier-a',
      accepted: true,
      detail: 'Reconnect cycled carrier-a: online -> dead -> online.',
      observedAt: 'now',
      states: { before: 'online', afterStop: 'dead', afterStart: 'online', cycleVerified: true },
    });

    const result: any = await controller.operate(request, smscId, 'reconnect', 'key-1', {
      reason: 'bind is flapping',
    });

    expect(completions[0].verification).toBe('bind_cycled');
    expect(result.states.cycleVerified).toBe(true);
  });

  it('records only command_accepted when the cycle could not be observed', async () => {
    const { controller, controlSmsc, completions } = makeController({ type: 'smpp' });
    controlSmsc.mockResolvedValue({
      operation: 'reconnect',
      engineId: 'carrier-a',
      accepted: true,
      detail: 'bearerbox /status.json is unavailable, so the bind cycle could NOT be verified.',
      observedAt: 'now',
      states: { before: null, afterStop: null, afterStart: null, cycleVerified: false },
    });

    await controller.operate(request, smscId, 'reconnect', 'key-1', { reason: 'bind is flapping' });

    // Distinguishable from a verified cycle — which is the whole point.
    expect(completions[0].verification).toBe('command_accepted');
  });

  /**
   * The impact preview declares `reconnect` and `disable` reason-required, and
   * this endpoint previously accepted no body at all — so it demanded a reason
   * in the dialog and then discarded it, writing the audit row with reason
   * NULL. A control that asks for a justification and drops it is worse than
   * one that never asked: the audit trail looks complete and is not.
   */
  it('refuses a reason-required operation with no reason', async () => {
    const { controller } = makeController({ type: 'smpp' });
    await expect(controller.operate(request, smscId, 'reconnect', 'key-1', {})).rejects.toThrow(
      /requires a reason/,
    );
  });

  it('carries the reason through to the operation record', async () => {
    const { controller, controlSmsc, beginArgs } = makeController({ type: 'smpp' });
    controlSmsc.mockResolvedValue({
      operation: 'reconnect',
      engineId: 'carrier-a',
      accepted: true,
      detail: 'accepted',
      observedAt: 'now',
    });
    await controller.operate(request, smscId, 'reconnect', 'key-1', {
      reason: 'carrier reported a stuck session',
    });
    expect(beginArgs[0]).toContain('carrier reported a stuck session');
  });

  it('makes no verification claim for enable or disable', async () => {
    for (const operation of ['enable', 'disable']) {
      const { controller, controlSmsc, completions } = makeController({ type: 'smpp' });
      controlSmsc.mockResolvedValue({
        operation,
        engineId: 'carrier-a',
        accepted: true,
        detail: 'accepted',
        observedAt: 'now',
      });
      // `disable` is reason-required (§16); `enable` is not, because putting an
      // SMSC back into service is not the disruptive direction.
      await controller.operate(request, smscId, operation, 'key-1', {
        reason: 'planned maintenance',
      });
      expect(completions[0].verification).toBeUndefined();
    }
  });
});
