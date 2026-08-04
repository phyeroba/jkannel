import { Injectable } from '@nestjs/common';
import { Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * A real SMPP v3.4 bind probe.
 *
 * "Test connection" used to be a bare TCP `connect()`. A socket opening proves
 * only that something is listening on the port: it says nothing about whether
 * the carrier will accept our system_id and password, which is the single thing
 * an operator clicking "Test" wants to know and the thing
 * SMSC_MANAGER_SPEC_10's "Bind succeeds" acceptance criterion asks for.
 *
 * This performs the actual handshake — bind_transmitter / bind_receiver /
 * bind_transceiver, read the *_resp, then a courteous `unbind` — and reports the
 * SMPP `command_status` the carrier returned. A failed bind (bad password,
 * unknown system id, already bound) is therefore reported as a FAILED test even
 * though the TCP socket opened perfectly.
 */

/** SMPP command ids used here. */
const COMMAND_ID = {
  bind_receiver: 0x00000001,
  bind_transmitter: 0x00000002,
  bind_transceiver: 0x00000009,
  unbind: 0x00000006,
} as const;

const RESPONSE_BIT = 0x80000000;

/** The command_status values a bind realistically returns (SMPP v3.4 §5.1.3). */
const COMMAND_STATUS: Readonly<Record<number, string>> = {
  0x00000000: 'ESME_ROK',
  0x00000001: 'ESME_RINVMSGLEN',
  0x00000002: 'ESME_RINVCMDLEN',
  0x00000003: 'ESME_RINVCMDID',
  0x00000004: 'ESME_RINVBNDSTS',
  0x00000005: 'ESME_RALYBND',
  0x00000006: 'ESME_RINVPRTFLG',
  0x00000008: 'ESME_RSYSERR',
  0x0000000a: 'ESME_RINVSRCADR',
  0x0000000d: 'ESME_RBINDFAIL',
  0x0000000e: 'ESME_RINVPASWD',
  0x0000000f: 'ESME_RINVSYSID',
  0x00000058: 'ESME_RTHROTTLED',
};

export type BindMode = 'transceiver' | 'transmitter' | 'receiver';

export interface SmppBindOptions {
  host: string;
  port: number;
  systemId: string;
  password: string;
  systemType?: string | null;
  /** 0x33 / 0x34 / 0x50 as stored (33 / 34 / 50 decimal in the database). */
  interfaceVersion?: number | null;
  bindMode?: BindMode | null;
  addressRange?: string | null;
  addrTon?: number | null;
  addrNpi?: number | null;
  useTls?: boolean | null;
  timeoutMs?: number;
}

export interface SmppBindResult {
  /** True only when the carrier returned a bind response with ESME_ROK. */
  bound: boolean;
  /** True when the TCP/TLS socket opened, whatever the bind then said. */
  connected: boolean;
  latencyMs: number;
  /** The carrier's command_status, or null when no response was read. */
  commandStatus: number | null;
  commandStatusName: string | null;
  /** The carrier's own system_id from the bind response, when it supplied one. */
  peerSystemId: string | null;
  detail: string;
}

/** interface_version stored as decimal 33/34/50 maps to the SMPP octet. */
function interfaceOctet(value: number | null | undefined): number {
  const table: Record<number, number> = { 33: 0x33, 34: 0x34, 50: 0x50 };
  if (value === null || value === undefined) return 0x34;
  return table[value] ?? (value >= 0 && value <= 0xff ? value : 0x34);
}

function cString(value: string | null | undefined, max: number): Buffer {
  const text = (value ?? '').slice(0, max);
  return Buffer.concat([Buffer.from(text, 'ascii'), Buffer.from([0])]);
}

function buildPdu(commandId: number, sequence: number, body: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length, 0);
  header.writeUInt32BE(commandId >>> 0, 4);
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, body]);
}

function bindCommandId(mode: BindMode | null | undefined): number {
  if (mode === 'transmitter') return COMMAND_ID.bind_transmitter;
  if (mode === 'receiver') return COMMAND_ID.bind_receiver;
  return COMMAND_ID.bind_transceiver;
}

/** First NUL-terminated string in a bind response body, if any. */
function firstCString(body: Buffer): string | null {
  const end = body.indexOf(0);
  if (end < 0) return null;
  const value = body.subarray(0, end).toString('ascii');
  return value.length ? value : null;
}

@Injectable()
export class SmppBindProber {
  /**
   * Opens a socket, binds, and unbinds. Never throws: every failure mode
   * (refused, timed out, TLS error, non-OK command_status, truncated PDU) is
   * reported in the result so the caller can record it verbatim.
   */
  bind(options: SmppBindOptions): Promise<SmppBindResult> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const started = Date.now();
    const commandId = bindCommandId(options.bindMode);

    return new Promise<SmppBindResult>((resolve) => {
      let settled = false;
      let connected = false;
      let buffer = Buffer.alloc(0);

      const socket: Socket = options.useTls
        ? tlsConnect({
            host: options.host,
            port: options.port,
            // A carrier's SMPP endpoint frequently presents a private CA; the
            // question this probe answers is "does the bind succeed", not "is
            // the chain publicly trusted", and refusing to test would be less
            // honest than testing and saying so.
            rejectUnauthorized: false,
          })
        : tcpConnect({ host: options.host, port: options.port });

      const finish = (result: Omit<SmppBindResult, 'latencyMs' | 'connected'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...result, connected, latencyMs: Date.now() - started });
      };

      const timer = setTimeout(
        () =>
          finish({
            bound: false,
            commandStatus: null,
            commandStatusName: null,
            peerSystemId: null,
            detail: connected
              ? `SMPP bind timed out after ${timeoutMs}ms: the socket opened but no bind response arrived`
              : `Connection timed out after ${timeoutMs}ms`,
          }),
        timeoutMs,
      );

      socket.once('error', (error: Error) =>
        finish({
          bound: false,
          commandStatus: null,
          commandStatusName: null,
          peerSystemId: null,
          detail: connected ? `SMPP bind failed: ${error.message}` : error.message,
        }),
      );

      socket.once('close', () => {
        if (settled) return;
        finish({
          bound: false,
          commandStatus: null,
          commandStatusName: null,
          peerSystemId: null,
          detail: connected
            ? 'The SMSC closed the connection before answering the bind'
            : 'The connection closed before it was established',
        });
      });

      const onConnect = () => {
        connected = true;
        const body = Buffer.concat([
          cString(options.systemId, 15),
          cString(options.password, 8),
          cString(options.systemType, 12),
          Buffer.from([
            interfaceOctet(options.interfaceVersion),
            (options.addrTon ?? 0) & 0xff,
            (options.addrNpi ?? 0) & 0xff,
          ]),
          cString(options.addressRange, 40),
        ]);
        socket.write(buildPdu(commandId, 1, body));
      };
      if (options.useTls) socket.once('secureConnect' as any, onConnect);
      else socket.once('connect', onConnect);

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 16) {
          const length = buffer.readUInt32BE(0);
          // A PDU shorter than its own header, or absurdly long, means we are
          // not talking to an SMPP peer at all.
          if (length < 16 || length > 1_048_576) {
            finish({
              bound: false,
              commandStatus: null,
              commandStatusName: null,
              peerSystemId: null,
              detail: `The endpoint answered with a ${length}-octet frame, which is not a valid SMPP PDU`,
            });
            return;
          }
          if (buffer.length < length) return;
          const pdu = buffer.subarray(0, length);
          buffer = buffer.subarray(length);

          const responseId = pdu.readUInt32BE(4);
          if (responseId !== (commandId | RESPONSE_BIT) >>> 0) continue;

          const status = pdu.readUInt32BE(8);
          const name = COMMAND_STATUS[status] ?? `0x${status.toString(16).padStart(8, '0')}`;
          const peerSystemId = firstCString(pdu.subarray(16));
          if (status === 0) {
            // Courtesy unbind so the carrier does not have to time the session
            // out; the answer is not waited for.
            try {
              socket.write(buildPdu(COMMAND_ID.unbind, 2, Buffer.alloc(0)));
            } catch {
              /* the bind already answered; an unbind write failure changes nothing */
            }
            finish({
              bound: true,
              commandStatus: 0,
              commandStatusName: name,
              peerSystemId,
              detail:
                `SMPP ${options.bindMode ?? 'transceiver'} bind succeeded as "${options.systemId}"` +
                (peerSystemId ? ` (SMSC system_id "${peerSystemId}")` : ''),
            });
            return;
          }
          finish({
            bound: false,
            commandStatus: status,
            commandStatusName: name,
            peerSystemId,
            detail: `SMPP bind rejected by the SMSC: ${name} (command_status 0x${status
              .toString(16)
              .padStart(8, '0')})`,
          });
          return;
        }
      });
    });
  }
}
