import { SecretResolver } from '../configuration/secret-resolver.service';
import { SmppBindProber } from './smpp-bind-prober';
import { ConnectivityTarget, SmscConnectivityService } from './smsc-connectivity.service';

/**
 * "Test connection" must never claim more than it verified. These tests hold
 * the two halves of that: a REAL SMPP bind whenever the credentials can be
 * resolved, and — when they cannot — a TCP check that says in its own words
 * that it is only a TCP check, and why the bind was skipped.
 */

function makeService(options: {
  bind?: jest.Mock;
  tcpReachable?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const bind =
    options.bind ??
    jest.fn(async () => ({
      bound: true,
      connected: true,
      latencyMs: 12,
      commandStatus: 0,
      commandStatusName: 'ESME_ROK',
      peerSystemId: 'CARRIER',
      detail: 'SMPP transceiver bind succeeded as "jkannel"',
    }));
  const prober: SmppBindProber = { bind };
  const service = new SmscConnectivityService(prober, new SecretResolver(options.env ?? {}));
  // The raw TCP primitive is stubbed: it has no bearing on which LEVEL was
  // chosen, which is what these tests are about.
  jest.spyOn(service, 'test').mockResolvedValue({
    reachable: options.tcpReachable ?? true,
    latencyMs: 4,
    detail: options.tcpReachable === false ? 'ECONNREFUSED' : 'TCP connection established',
  });
  return { service, bind };
}

const smppSmsc = {
  type: 'smpp',
  host: 'carrier.example',
  port: 2775,
  system_id: 'jkannel',
  credential_secret_ref: 'secret://carrier/password',
  system_type: 'SMPP',
  bind_mode: 'transceiver',
  interface_version: 34,
  source_addr_ton: 0,
  source_addr_npi: 1,
};

/** The environment in which the carrier password IS resolvable. */
const withPassword = { CARRIER_PASSWORD: 's3cret' };

describe('a real SMPP bind when the credentials resolve', () => {
  it('binds, and says it verified a bind', async () => {
    const { service, bind } = makeService({ env: withPassword });
    const result = await service.verify(smppSmsc);

    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'carrier.example',
        port: 2775,
        systemId: 'jkannel',
        password: 's3cret',
        bindMode: 'transceiver',
        interfaceVersion: 34,
      }),
    );
    expect(result.verified).toBe('smpp_bind');
    expect(result.passed).toBe(true);
    expect(result.bound).toBe(true);
    expect(result.commandStatusName).toBe('ESME_ROK');
  });

  it('FAILS the test when the socket opens but the bind is rejected', async () => {
    const bind = jest.fn(async () => ({
      bound: false,
      connected: true,
      latencyMs: 9,
      commandStatus: 0x0e,
      commandStatusName: 'ESME_RINVPASWD',
      peerSystemId: null,
      detail: 'SMPP bind rejected by the SMSC: ESME_RINVPASWD (command_status 0x0000000e)',
    }));
    const { service } = makeService({ bind, env: withPassword });
    const result = await service.verify(smppSmsc);

    // Reachable, and still a failure. This is precisely what the old bare TCP
    // check reported as a success.
    expect(result.reachable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.bound).toBe(false);
    expect(result.verified).toBe('smpp_bind');
  });

  it('falls back to username_secret_ref when no literal system_id is stored', async () => {
    const { service, bind } = makeService({
      env: { ...withPassword, CARRIER_USERNAME: 'from-secret' },
    });
    await service.verify({
      ...smppSmsc,
      system_id: null,
      username_secret_ref: 'secret://carrier/username',
    });
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ systemId: 'from-secret' }));
  });
});

describe('TCP-only checks say so, and say why', () => {
  it('does not attempt a bind when the password secret is not in this container', async () => {
    const { service, bind } = makeService({ env: {} });
    const result = await service.verify(smppSmsc);

    expect(bind).not.toHaveBeenCalled();
    expect(result.verified).toBe('tcp_socket');
    expect(result.bound).toBeNull();
    expect(result.detail).toContain('NOT an SMPP bind');
    // It must name the environment variable so the gap is actionable.
    expect(result.bindSkippedReason).toContain('CARRIER_PASSWORD');
  });

  it('does not attempt a bind when no system_id is configured', async () => {
    const { service } = makeService({ env: withPassword });
    const result = await service.verify({ ...smppSmsc, system_id: null });
    expect(result.verified).toBe('tcp_socket');
    expect(result.bindSkippedReason).toContain('no SMPP system_id');
  });

  it.each(['http', 'at'])('reports a %s SMSC as TCP-verified only', async (type) => {
    const { service, bind } = makeService({ env: withPassword });
    const result = await service.verify({ ...smppSmsc, type });
    expect(bind).not.toHaveBeenCalled();
    expect(result.verified).toBe('tcp_socket');
    expect(result.bindSkippedReason).toContain(`type "${type}" has no SMPP bind`);
  });

  it('fails the check, still labelled tcp_socket, when the socket will not open', async () => {
    const { service } = makeService({ env: {}, tcpReachable: false });
    const result = await service.verify(smppSmsc);
    expect(result.verified).toBe('tcp_socket');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('No SMPP bind was attempted');
  });
});

describe('nothing to verify', () => {
  it('says a fake SMSC verified nothing rather than reporting a pass as a connection', async () => {
    const { service } = makeService({});
    const result = await service.verify({ type: 'fake' });
    expect(result.verified).toBe('not_applicable');
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('nothing was verified');
  });

  it.each([
    { type: 'smpp', host: '', port: 2775 },
    { type: 'smpp', host: 'carrier.example', port: null },
    { type: 'smpp', host: 'carrier.example', port: 70000 },
  ])('fails an SMSC with no usable endpoint (%p)', async (smsc: ConnectivityTarget) => {
    const { service } = makeService({});
    const result = await service.verify(smsc);
    expect(result.verified).toBe('not_applicable');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('No usable host/port');
  });
});
