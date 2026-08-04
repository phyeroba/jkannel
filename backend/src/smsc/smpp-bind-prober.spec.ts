import { AddressInfo, Server, createServer } from 'node:net';
import { SmppBindProber } from './smpp-bind-prober';

/**
 * Exercised against a real listening socket that speaks (or deliberately
 * mis-speaks) SMPP, because the whole point of this class is that it does more
 * than open a TCP connection — mocking the socket would test nothing.
 */

interface FakeSmsc {
  server: Server;
  port: number;
  /** Bind PDUs the server received, parsed. */
  received: Array<{
    commandId: number;
    systemId: string;
    password: string;
    systemType: string;
    interfaceVersion: number;
  }>;
  close: () => Promise<void>;
}

type Behaviour =
  | { kind: 'answer'; status: number; systemId?: string }
  | { kind: 'silence' }
  | { kind: 'hangup' }
  | { kind: 'garbage' };

async function startFakeSmsc(behaviour: Behaviour): Promise<FakeSmsc> {
  const received: FakeSmsc['received'] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      if (chunk.length < 16) return;
      const commandId = chunk.readUInt32BE(4);
      // unbind: acknowledge and go away.
      if (commandId === 0x00000006) {
        socket.end();
        return;
      }
      const body = chunk.subarray(16);
      const parts = body.toString('binary').split('\0');
      received.push({
        commandId,
        systemId: parts[0],
        password: parts[1],
        systemType: parts[2],
        interfaceVersion: body[parts[0].length + parts[1].length + parts[2].length + 3],
      });
      if (behaviour.kind === 'silence') return;
      if (behaviour.kind === 'hangup') {
        socket.destroy();
        return;
      }
      if (behaviour.kind === 'garbage') {
        const frame = Buffer.alloc(16);
        frame.writeUInt32BE(4, 0); // an impossible PDU length
        socket.write(frame);
        return;
      }
      const peer = Buffer.concat([
        Buffer.from(behaviour.systemId ?? 'CARRIER', 'ascii'),
        Buffer.from([0]),
      ]);
      const response = Buffer.alloc(16 + peer.length);
      response.writeUInt32BE(16 + peer.length, 0);
      response.writeUInt32BE((commandId | 0x80000000) >>> 0, 4);
      response.writeUInt32BE(behaviour.status, 8);
      response.writeUInt32BE(chunk.readUInt32BE(12), 12);
      peer.copy(response, 16);
      socket.write(response);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const prober = new SmppBindProber();
const credentials = { systemId: 'jkannel', password: 'hunter2' };

describe('a successful bind', () => {
  it('reports bound=true and the carrier’s own system_id', async () => {
    const smsc = await startFakeSmsc({ kind: 'answer', status: 0, systemId: 'CARRIER-A' });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 2000,
      });
      expect(result.bound).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.commandStatus).toBe(0);
      expect(result.commandStatusName).toBe('ESME_ROK');
      expect(result.peerSystemId).toBe('CARRIER-A');
      expect(result.detail).toContain('bind succeeded');
    } finally {
      await smsc.close();
    }
  });

  it('sends a well-formed bind_transceiver carrying the credentials', async () => {
    const smsc = await startFakeSmsc({ kind: 'answer', status: 0 });
    try {
      await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        systemType: 'SMPP',
        interfaceVersion: 34,
        timeoutMs: 2000,
      });
      expect(smsc.received[0]).toMatchObject({
        commandId: 0x00000009,
        systemId: 'jkannel',
        password: 'hunter2',
        systemType: 'SMPP',
        interfaceVersion: 0x34,
      });
    } finally {
      await smsc.close();
    }
  });

  it.each([
    ['transmitter', 0x00000002],
    ['receiver', 0x00000001],
    ['transceiver', 0x00000009],
  ] as const)('binds as a %s', async (bindMode, commandId) => {
    const smsc = await startFakeSmsc({ kind: 'answer', status: 0 });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        bindMode,
        timeoutMs: 2000,
      });
      expect(smsc.received[0].commandId).toBe(commandId);
      expect(result.bound).toBe(true);
    } finally {
      await smsc.close();
    }
  });
});

describe('a bind the carrier refuses is a FAILED test, even though the socket opened', () => {
  it.each([
    [0x0000000e, 'ESME_RINVPASWD'],
    [0x0000000f, 'ESME_RINVSYSID'],
    [0x00000005, 'ESME_RALYBND'],
    [0x0000000d, 'ESME_RBINDFAIL'],
  ])('reports command_status %i as %s', async (status, name) => {
    const smsc = await startFakeSmsc({ kind: 'answer', status });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 2000,
      });
      // This is the whole difference from the old TCP check: reachable, but
      // NOT bound.
      expect(result.connected).toBe(true);
      expect(result.bound).toBe(false);
      expect(result.commandStatusName).toBe(name);
      expect(result.detail).toContain('rejected by the SMSC');
    } finally {
      await smsc.close();
    }
  });

  it('names an unrecognised status by its hex value rather than inventing one', async () => {
    const smsc = await startFakeSmsc({ kind: 'answer', status: 0x000000ff });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 2000,
      });
      expect(result.commandStatusName).toBe('0x000000ff');
    } finally {
      await smsc.close();
    }
  });
});

describe('failure modes are reported, never thrown', () => {
  it('times out when the endpoint accepts the socket but never answers', async () => {
    const smsc = await startFakeSmsc({ kind: 'silence' });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 200,
      });
      expect(result.bound).toBe(false);
      expect(result.connected).toBe(true);
      expect(result.detail).toContain('no bind response arrived');
    } finally {
      await smsc.close();
    }
  });

  it('reports a hang-up mid-handshake', async () => {
    const smsc = await startFakeSmsc({ kind: 'hangup' });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 2000,
      });
      expect(result.bound).toBe(false);
      expect(result.connected).toBe(true);
    } finally {
      await smsc.close();
    }
  });

  it('says so when the endpoint is not speaking SMPP at all', async () => {
    const smsc = await startFakeSmsc({ kind: 'garbage' });
    try {
      const result = await prober.bind({
        host: '127.0.0.1',
        port: smsc.port,
        ...credentials,
        timeoutMs: 2000,
      });
      expect(result.bound).toBe(false);
      expect(result.detail).toContain('not a valid SMPP PDU');
    } finally {
      await smsc.close();
    }
  });

  it('reports a refused connection without ever claiming to have connected', async () => {
    const smsc = await startFakeSmsc({ kind: 'answer', status: 0 });
    const port = smsc.port;
    await smsc.close();
    const result = await prober.bind({ host: '127.0.0.1', port, ...credentials, timeoutMs: 1000 });
    expect(result.connected).toBe(false);
    expect(result.bound).toBe(false);
  });
});
