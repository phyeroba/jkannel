import { Injectable, Optional } from '@nestjs/common';
import { connect } from 'node:net';
import { SecretResolver } from '../configuration/secret-resolver.service';
import { SmppBindProber, BindMode } from './smpp-bind-prober';

/**
 * What a connectivity check ACTUALLY proved. The console renders this verbatim;
 * nothing here may be presented as more than it is.
 *
 * - `smpp_bind`     — an SMPP bind was attempted and the carrier answered.
 * - `tcp_socket`    — a TCP socket opened. Proves a listener exists, nothing
 *                     about credentials or the SMPP layer.
 * - `not_applicable`— the SMSC has no network endpoint to verify (type `fake`).
 */
export type VerificationLevel = 'smpp_bind' | 'tcp_socket' | 'not_applicable';

export interface ConnectivityVerification {
  /** Exactly what was verified. Never widen this. */
  verified: VerificationLevel;
  /** Whether the check passed at the level stated by `verified`. */
  passed: boolean;
  /** The socket opened (or there was nothing to open). */
  reachable: boolean;
  /** Bind outcome; null when no bind was attempted. */
  bound: boolean | null;
  latencyMs: number;
  /** Operator-facing sentence that states the level it was verified at. */
  detail: string;
  /** Why the stronger SMPP bind check was NOT run, when it was not. */
  bindSkippedReason?: string;
  /** The carrier's SMPP command_status, when a bind was answered. */
  commandStatus?: number | null;
  commandStatusName?: string | null;
}

/** The SMSC row fields this service reads (a subset of smsc_definitions). */
export interface ConnectivityTarget {
  type?: string | null;
  host?: string | null;
  port?: number | null;
  system_id?: string | null;
  username_secret_ref?: string | null;
  credential_secret_ref?: string | null;
  system_type?: string | null;
  bind_mode?: string | null;
  interface_version?: number | null;
  address_range?: string | null;
  source_addr_ton?: number | null;
  source_addr_npi?: number | null;
  use_tls?: boolean | null;
}

/**
 * SMSC connectivity verification.
 *
 * {@link test} is retained unchanged as the raw TCP reachability primitive, and
 * is now named for what it is everywhere it is reported. {@link verify} is what
 * the console's "Test connection" action calls: for an SMPP SMSC whose
 * credentials this container can resolve it performs a REAL bind
 * ({@link SmppBindProber}); when it cannot, it falls back to TCP and states, in
 * the result the operator sees, both that only a socket was checked and the
 * precise reason the bind was not attempted.
 *
 * The credentials deliberately live in the ENGINE container's environment in the
 * standard deployment (see SecretResolver's class doc), so the TCP fallback is
 * the expected outcome there — and saying so plainly is the whole point of this
 * change.
 */
@Injectable()
export class SmscConnectivityService {
  constructor(
    @Optional() private readonly prober: SmppBindProber = new SmppBindProber(),
    @Optional() private readonly secrets: SecretResolver = new SecretResolver(),
  ) {}

  /**
   * Raw TCP reachability. Proves a listener accepted a connection — NOT that an
   * SMPP bind would succeed. Callers must report it as such.
   */
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

  /** Resolves a `secret://` reference, or explains why it could not be. */
  private resolveSecret(reference: string | null | undefined): {
    value: string | null;
    reason: string | null;
  } {
    if (!reference) return { value: null, reason: null };
    if (!this.secrets.isReference(reference))
      // A literal (non-secret://) value: the SMSC validator rejects those on
      // write, but historical rows may still carry one.
      return { value: reference, reason: null };
    try {
      if (!this.secrets.has(reference))
        return {
          value: null,
          reason: `${reference} is not present in this container's environment (expected ${this.secrets.envName(reference)})`,
        };
      return { value: this.secrets.resolve(reference), reason: null };
    } catch (error) {
      return {
        value: null,
        reason: `${reference} could not be resolved: ${(error as Error).message}`,
      };
    }
  }

  /** TCP-only result, labelled with why no bind was attempted. */
  private async tcpOnly(
    host: string,
    port: number,
    bindSkippedReason: string,
    timeoutMs: number,
  ): Promise<ConnectivityVerification> {
    const result = await this.test(host, port, timeoutMs);
    return {
      verified: 'tcp_socket',
      passed: result.reachable,
      reachable: result.reachable,
      bound: null,
      latencyMs: result.latencyMs,
      detail: result.reachable
        ? `TCP socket to ${host}:${port} opened. This is NOT an SMPP bind — ${bindSkippedReason}.`
        : `TCP connection to ${host}:${port} failed: ${result.detail}. No SMPP bind was attempted — ${bindSkippedReason}.`,
      bindSkippedReason,
    };
  }

  /**
   * Verifies an SMSC as deeply as this container can, and reports the depth.
   */
  async verify(smsc: ConnectivityTarget, timeoutMs = 5000): Promise<ConnectivityVerification> {
    const type = (smsc.type ?? '').trim().toLowerCase();
    if (type === 'fake')
      return {
        verified: 'not_applicable',
        passed: true,
        reachable: true,
        bound: null,
        latencyMs: 0,
        detail: 'Fake SMSC has no network endpoint; nothing was verified beyond its configuration.',
      };

    const host = (smsc.host ?? '').trim();
    const port = Number(smsc.port ?? 0);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      return {
        verified: 'not_applicable',
        passed: false,
        reachable: false,
        bound: null,
        latencyMs: 0,
        detail: 'No usable host/port is configured for this SMSC; nothing could be verified.',
      };

    if (type !== 'smpp')
      return this.tcpOnly(
        host,
        port,
        `SMSC type "${type || 'unknown'}" has no SMPP bind to verify`,
        timeoutMs,
      );

    const username = this.resolveSecret(smsc.username_secret_ref);
    const systemId = (smsc.system_id ?? '').trim() || username.value || '';
    const password = this.resolveSecret(smsc.credential_secret_ref);

    if (!systemId)
      return this.tcpOnly(
        host,
        port,
        username.reason
          ? `no SMPP system_id is available (${username.reason})`
          : 'no SMPP system_id is configured for this SMSC',
        timeoutMs,
      );
    if (!password.value)
      return this.tcpOnly(
        host,
        port,
        password.reason ??
          'no credential_secret_ref is configured, so there is no password to bind with',
        timeoutMs,
      );

    const result = await this.prober.bind({
      host,
      port,
      systemId,
      password: password.value,
      systemType: smsc.system_type,
      interfaceVersion: smsc.interface_version,
      bindMode: (smsc.bind_mode as BindMode | null) ?? 'transceiver',
      addressRange: smsc.address_range,
      addrTon: smsc.source_addr_ton,
      addrNpi: smsc.source_addr_npi,
      useTls: smsc.use_tls,
      timeoutMs,
    });
    return {
      verified: 'smpp_bind',
      passed: result.bound,
      reachable: result.connected,
      bound: result.bound,
      latencyMs: result.latencyMs,
      detail: result.detail,
      commandStatus: result.commandStatus,
      commandStatusName: result.commandStatusName,
    };
  }
}
