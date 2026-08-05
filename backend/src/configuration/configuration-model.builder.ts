import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  EngineConfiguration,
  EngineSmsc,
  SmscBindMode,
  WaitAckExpireAction,
} from './configuration-generator.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface BuildOptions {
  /** Include SMSCs that are disabled or not yet deployed. Off by default. */
  includeInactive?: boolean;
}

export interface BuiltConfiguration {
  model: EngineConfiguration;
  /** Where each part of the model came from, for the preview UI and audit. */
  sources: {
    smscCount: number;
    /** SMSC engine ids that were read but excluded, with the reason. */
    excluded: Array<{ engineId: string; reason: string }>;
    settingsApplied: string[];
  };
}

/** SMSC lifecycle states that must never reach a generated configuration. */
const NON_RENDERABLE_STATES = ['archived', 'disabled'];

/**
 * Global settings the builder honours, with the environment variable that acts
 * as the fallback and the built-in default. `system_settings` is the tenant's
 * override, the environment is the deployment's, and the default reproduces
 * the shipped `runtime/kamex/kamex.conf`.
 */
const GATEWAY_SETTINGS = {
  adminPort: { key: 'gateway.admin_port', env: 'KAMEX_ADMIN_PORT', fallback: 13000 },
  smsboxPort: { key: 'gateway.smsbox_port', env: 'KAMEX_SMSBOX_PORT', fallback: 13001 },
  sendsmsPort: { key: 'gateway.sendsms_port', env: 'KAMEX_SENDSMS_PORT', fallback: 13013 },
  logLevel: { key: 'gateway.log_level', env: 'KAMEX_LOG_LEVEL', fallback: 1 },
  /**
   * Only consulted when SQLBox is NOT part of the topology. With SQLBox
   * deployed the smsbox upstream is DERIVED, not configured — see
   * {@link ConfigurationModelBuilder.smsboxUpstream}.
   */
  bearerboxHost: {
    key: 'gateway.bearerbox_host',
    env: 'KAMEX_BEARERBOX_HOST',
    fallback: 'kamex-bearerbox',
  },
  /** SQLBox's own network name (docker-compose service `kamex-sqlbox`). */
  sqlboxHost: {
    key: 'gateway.sqlbox_host',
    env: 'KAMEX_SQLBOX_HOST',
    fallback: 'kamex-sqlbox',
  },
  sendsmsUsername: {
    key: 'gateway.sendsms_username',
    env: 'KAMEX_SENDSMS_USERNAME',
    fallback: 'jkannel',
  },
  /**
   * Base URL of the platform's MO push endpoint. Empty (the default) means no
   * `post-url` is rendered and inbound messages are picked up by the engine
   * sweep instead. Never a guessed default: a wrong callback URL produces one
   * failed HTTP request per inbound message, forever, in silence.
   */
  moPushUrl: {
    key: 'gateway.mo_push_url',
    env: 'KAMEX_MO_PUSH_URL',
    fallback: '',
  },
} as const;

/**
 * The query string the MO `sms-service` appends to the operator's base URL.
 *
 * Every code here was read out of the Kamex 1.8.3 source that this project
 * pins (gw/urltrans.c urltrans_fill_escape_codes_ex), NOT out of documentation:
 *
 *   %p  sms.receiver  -> the ORIGINAL SENDER. gw/smsbox.c swaps sender and
 *                        receiver before calling the service (it is building
 *                        the reply message), and urltrans.c says so in a
 *                        comment: "the sender and receiver is already switched
 *                        in message". So %p, not %P, is who texted in.
 *   %P  sms.sender    -> the ORIGINAL RECEIVER (the short code / MSISDN dialled).
 *   %b  msgdata, URL-encoded. %a is the wrong choice for a message body: it
 *       splits on whitespace and rejoins the words with '+', so runs of spaces
 *       and leading/trailing spaces do not survive.
 *   %i  smsc-id of the bind the message arrived on.
 *   %I  the engine's own message UUID — a natural idempotency handle, which is
 *       exactly what MoInboundService's `externalRef` -> `dedupe_key` wants.
 *   %T  sms.time as a unix timestamp. %t also exists but renders
 *       "YYYY-MM-DD+HH:MM:SS" in GMT with no zone marker, which a JS `new Date`
 *       would read as local time.
 *
 * (%q and %Q are NOT "the same without a +". They are %p and %Q's values with a
 * leading "00" rewritten to "%2B"; %q pairs with %p, %Q pairs with %P.)
 */
export const MO_PUSH_QUERY = 'sender=%p&receiver=%P&text=%b&smscId=%i&externalRef=%I&receivedAt=%T';

interface SmscRow {
  engine_id: string;
  type: string;
  host: string | null;
  port: number | null;
  receive_port: number | null;
  system_id: string | null;
  username_secret_ref: string | null;
  credential_secret_ref: string | null;
  system_type: string | null;
  bind_mode: string | null;
  interface_version: number | null;
  address_range: string | null;
  source_addr_ton: number | null;
  source_addr_npi: number | null;
  dest_addr_ton: number | null;
  dest_addr_npi: number | null;
  window_size: number | null;
  tps: number | null;
  keepalive_seconds: number | null;
  reconnect_delay_seconds: number | null;
  wait_ack_seconds: number | null;
  max_error_count: number | null;
  use_tls: boolean | null;
  alt_charset: string | null;
  send_url: string | null;
  // Migration 041.
  connection_count: number | null;
  connection_timeout_seconds: number | null;
  wait_ack_expire_action: number | null;
  retry_on_auth_failure: boolean | null;
  allowed_smsc_ids: string[] | null;
  denied_smsc_ids: string[] | null;
  preferred_smsc_ids: string[] | null;
  allowed_prefixes: string[] | null;
  denied_prefixes: string[] | null;
  preferred_prefixes: string[] | null;
  enabled: boolean;
  lifecycle_state: string;
}

const SMSC_COLUMNS = `engine_id, type, host, port, receive_port, system_id, username_secret_ref,
  credential_secret_ref, system_type, bind_mode, interface_version, address_range,
  source_addr_ton, source_addr_npi, dest_addr_ton, dest_addr_npi, window_size, tps,
  keepalive_seconds, reconnect_delay_seconds, wait_ack_seconds, max_error_count,
  use_tls, alt_charset, send_url, connection_count, connection_timeout_seconds,
  wait_ack_expire_action, retry_on_auth_failure, allowed_smsc_ids, denied_smsc_ids,
  preferred_smsc_ids, allowed_prefixes, denied_prefixes, preferred_prefixes,
  enabled, lifecycle_state`;

const numberOrUndefined = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);

/**
 * A routing list only reaches the model when it has entries: an empty array is
 * the column default and must render nothing, so it is dropped here rather than
 * carried through as `[]` for the renderer to second-guess.
 */
const listOrUndefined = (value: string[] | null | undefined): string[] | undefined =>
  Array.isArray(value) && value.length ? value : undefined;

/**
 * Builds the internal {@link EngineConfiguration} from the tenant's operational
 * state in PostgreSQL — the wire that was missing between the SMSC Manager and
 * the Configuration Generator. CONFIGURATION_GENERATOR_SPEC §5/§10: "the
 * database is the source of truth".
 *
 * Scoping. Every read runs inside {@link DatabaseService.tenantTransaction},
 * which sets `app.tenant_id` so the FORCE ROW LEVEL SECURITY policy on
 * `smsc_definitions` (migrations 004/011) filters other tenants out at the
 * database. The queries additionally carry an explicit `tenant_id = $1`
 * predicate: redundant under RLS by design, but it makes the tenant scope
 * visible in the SQL, keeps the intent correct if a future caller ever runs
 * with the owner role, and is directly assertable in tests.
 *
 * Row filtering. Only live rows reach the model: `deleted_at IS NULL`
 * (soft delete, migration 027), `enabled = true`, and a lifecycle state that is
 * neither 'archived' nor 'disabled'. Rows excluded for those reasons are
 * reported in {@link BuiltConfiguration.sources.excluded} rather than silently
 * dropped, so an operator can see why an SMSC they created is not in the
 * rendered file.
 */
@Injectable()
export class ConfigurationModelBuilder {
  constructor(private readonly database: DatabaseService) {}

  async build(actor: Actor, options: BuildOptions = {}): Promise<BuiltConfiguration> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const [rows, settings] = await Promise.all([
        this.readSmscs(client, actor.tenantId),
        this.readSettings(client, actor.tenantId),
      ]);
      return this.compose(rows, settings, options);
    });
  }

  private async readSmscs(client: PoolClient, tenantId: string): Promise<SmscRow[]> {
    // deleted_at is filtered in SQL (a soft-deleted SMSC is gone, full stop);
    // enabled/lifecycle_state are filtered in compose() so the reason for each
    // exclusion can be reported back to the operator.
    const result = await client.query<SmscRow>(
      `SELECT ${SMSC_COLUMNS}
         FROM smsc_definitions
        WHERE tenant_id = $1
          AND deleted_at IS NULL
        ORDER BY priority, engine_id`,
      [tenantId],
    );
    return result.rows;
  }

  private async readSettings(client: PoolClient, tenantId: string): Promise<Map<string, unknown>> {
    const result = await client.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM system_settings WHERE tenant_id = $1 AND key LIKE 'gateway.%'`,
      [tenantId],
    );
    return new Map(result.rows.map((row) => [row.key, row.value]));
  }

  private setting<T extends string | number>(
    settings: Map<string, unknown>,
    applied: string[],
    spec: { key: string; env: string; fallback: T },
  ): T {
    const stored = settings.get(spec.key);
    if (stored !== undefined && stored !== null) {
      applied.push(spec.key);
      return (typeof spec.fallback === 'number' ? Number(stored) : String(stored)) as T;
    }
    const fromEnv = process.env[spec.env];
    if (fromEnv !== undefined && fromEnv !== '') {
      applied.push(spec.env);
      return (typeof spec.fallback === 'number' ? Number(fromEnv) : fromEnv) as T;
    }
    return spec.fallback;
  }

  /**
   * The stored or environment value if the operator actually set one, else
   * undefined — deliberately WITHOUT falling back.
   *
   * {@link setting} cannot answer "did someone choose this?", because its
   * fallback is indistinguishable from a deliberate choice of the same value.
   * The smsbox-upstream conflict check needs that distinction: silently
   * overriding a stated intent and silently accepting an unstated default are
   * different acts, and only the first deserves an error.
   */
  private explicitSetting(
    settings: Map<string, unknown>,
    spec: { key: string; env: string },
  ): string | undefined {
    const stored = settings.get(spec.key);
    if (stored !== undefined && stored !== null && String(stored) !== '') return String(stored);
    const fromEnv = process.env[spec.env];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
  }

  private compose(
    rows: SmscRow[],
    settings: Map<string, unknown>,
    options: BuildOptions,
  ): BuiltConfiguration {
    const excluded: Array<{ engineId: string; reason: string }> = [];
    const settingsApplied: string[] = [];
    const smsc: EngineSmsc[] = [];

    for (const row of rows) {
      if (!options.includeInactive) {
        if (!row.enabled) {
          excluded.push({ engineId: row.engine_id, reason: 'disabled' });
          continue;
        }
        if (NON_RENDERABLE_STATES.includes(row.lifecycle_state)) {
          excluded.push({
            engineId: row.engine_id,
            reason: `lifecycle_state=${row.lifecycle_state}`,
          });
          continue;
        }
      }
      smsc.push(this.toEngineSmsc(row));
    }

    const adminPort = this.setting(settings, settingsApplied, GATEWAY_SETTINGS.adminPort);
    const smsboxPort = this.setting(settings, settingsApplied, GATEWAY_SETTINGS.smsboxPort);
    const sendsmsPort = this.setting(settings, settingsApplied, GATEWAY_SETTINGS.sendsmsPort);
    const logLevelValue = this.setting(settings, settingsApplied, GATEWAY_SETTINGS.logLevel);
    const logLevel = ([0, 1, 2, 3, 4].includes(logLevelValue) ? logLevelValue : 1) as
      0 | 1 | 2 | 3 | 4;

    // SQLBox must resolve BEFORE the smsbox group is built: with SQLBox in the
    // topology the smsbox upstream is derived from it rather than defaulted.
    const sqlbox = this.sqlboxFromEnvironment(settings, settingsApplied);

    const model: EngineConfiguration = {
      adminPort,
      smsboxPort,
      adminSecretRef: 'secret://kamex/admin-password',
      statusSecretRef: 'secret://kamex/status-password',
      logLevel,
      smsc,
      // A gateway without these three groups accepts no traffic: smsbox is the
      // MT/MO box, sendsms-user is the HTTP submit account the backend uses,
      // and a default sms-service is required for inbound messages. Shapes match
      // runtime/kamex/kamex.conf.
      smsbox: {
        bearerboxHost: this.smsboxUpstream(sqlbox, settings, settingsApplied),
        sendsmsPort,
        logLevel,
      },
      sendsmsUsers: [
        {
          username: this.setting(settings, settingsApplied, GATEWAY_SETTINGS.sendsmsUsername),
          passwordSecretRef: 'secret://kamex/sendsms-password',
        },
      ],
      smsServices: this.moServices(settings, settingsApplied),
      dlrStorage: { type: 'internal' },
    };

    if (sqlbox) model.sqlbox = sqlbox;

    return { model, sources: { smscCount: smsc.length, excluded, settingsApplied } };
  }

  /**
   * Which host the smsbox connects to — and the reason this is derived rather
   * than defaulted.
   *
   * SQLBox is a transparent boxc proxy that sits BETWEEN smsbox and bearerbox.
   * Point the smsbox straight at bearerbox while SQLBox is deployed and
   * everything still appears to work: messages send normally, and the only
   * symptom is that `sent_sms` stops being written. That table is the engine's
   * message history AND the table MO ingest sweeps, so inbound delivery dies
   * with it — silently, with no error anywhere.
   *
   * The previous code defaulted this to `kamex-bearerbox`, which is exactly
   * that bypass. Replacing one default with a better default would leave the
   * same class of bug one environment variable away, so instead: when SQLBox is
   * present the answer comes from the topology, and an operator who has
   * EXPLICITLY set a conflicting host gets a loud failure rather than a silent
   * override of what they asked for.
   */
  private smsboxUpstream(
    sqlbox: EngineConfiguration['sqlbox'] | undefined,
    settings: Map<string, unknown>,
    applied: string[],
  ): string {
    if (!sqlbox?.enabled) return this.setting(settings, applied, GATEWAY_SETTINGS.bearerboxHost);

    const explicit = this.explicitSetting(settings, GATEWAY_SETTINGS.bearerboxHost);
    if (explicit !== undefined && explicit !== sqlbox.serviceHost)
      throw new BadRequestException(
        `smsbox upstream conflict: SQLBox is deployed at "${sqlbox.serviceHost}", but ` +
          `${GATEWAY_SETTINGS.bearerboxHost.key} / ${GATEWAY_SETTINGS.bearerboxHost.env} is set ` +
          `to "${explicit}". Sending the smsbox straight to bearerbox bypasses SQLBox, which ` +
          'stops sent_sms being written and silently kills message history and MO ingest. ' +
          'Clear the override, or point it at the SQLBox host.',
      );
    // No `applied` entry here: sqlboxFromEnvironment already recorded whichever
    // source supplied serviceHost. Pushing again would double-report it.
    return sqlbox.serviceHost;
  }

  /**
   * The inbound (`sms-service`) groups.
   *
   * `maxMessages: 0` is on BOTH branches and is the point of this method. With
   * no matching service Kannel answers every inbound message with a canned MT
   * (`gw/smsbox.c:1909`) — a real, billable message sent to any subscriber who
   * texts in. `max-messages = 0` is the documented kill switch for that
   * (`gw/smsbox.c:322`). It matters even more on the push branch, where the
   * "reply" would otherwise be the HTTP response body: a JSON API answering a
   * callback would SMS its own response envelope back to the subscriber.
   *
   * The push URL has no default. A guessed callback address produces one failed
   * HTTP request per inbound message, forever, in silence — so absent means
   * absent, and inbound is picked up by the engine sweep instead.
   */
  private moServices(
    settings: Map<string, unknown>,
    applied: string[],
  ): EngineConfiguration['smsServices'] {
    const base = String(this.setting(settings, applied, GATEWAY_SETTINGS.moPushUrl) ?? '').trim();
    if (!base) return [{ keyword: 'default', text: 'No service specified', maxMessages: 0 }];

    if (!/^https?:\/\/[^\s"'\\]+$/.test(base))
      throw new BadRequestException(
        `${GATEWAY_SETTINGS.moPushUrl.key} must be an absolute http(s) URL, got "${base}"`,
      );
    // The builder owns the query string so the escape codes cannot be got
    // wrong by hand; a caller-supplied one would be silently appended to ours.
    if (base.includes('?'))
      throw new BadRequestException(
        `${GATEWAY_SETTINGS.moPushUrl.key} must not contain a query string; JKANNEL appends its ` +
          `own (${MO_PUSH_QUERY})`,
      );
    return [
      {
        keyword: 'default',
        catchAll: true,
        postUrl: `${base}?${MO_PUSH_QUERY}`,
        maxMessages: 0,
        omitEmpty: true,
        acceptXKannelHeaders: true,
        sendSender: true,
      },
    ];
  }

  private toEngineSmsc(row: SmscRow): EngineSmsc {
    const type = row.type as EngineSmsc['type'];
    const bindMode = (row.bind_mode ?? 'transceiver') as SmscBindMode;
    return {
      id: row.engine_id,
      type,
      enabled: true,
      host: row.host ?? undefined,
      port: numberOrUndefined(row.port),
      receivePort: numberOrUndefined(row.receive_port),
      username: row.system_id ?? undefined,
      usernameSecretRef: row.username_secret_ref ?? undefined,
      passwordSecretRef: row.credential_secret_ref ?? undefined,
      systemType: row.system_type ?? undefined,
      bindMode,
      interfaceVersion: numberOrUndefined(row.interface_version),
      addressRange: row.address_range ?? undefined,
      sourceAddrTon: numberOrUndefined(row.source_addr_ton),
      sourceAddrNpi: numberOrUndefined(row.source_addr_npi),
      destAddrTon: numberOrUndefined(row.dest_addr_ton),
      destAddrNpi: numberOrUndefined(row.dest_addr_npi),
      windowSize: numberOrUndefined(row.window_size),
      // Throughput is the operator-facing TPS cap; there is deliberately no
      // second column for it.
      throughput: numberOrUndefined(row.tps),
      keepaliveSeconds: numberOrUndefined(row.keepalive_seconds),
      reconnectDelaySeconds: numberOrUndefined(row.reconnect_delay_seconds),
      waitAckSeconds: numberOrUndefined(row.wait_ack_seconds),
      maxErrorCount: numberOrUndefined(row.max_error_count),
      useTls: row.use_tls ?? undefined,
      altCharset: row.alt_charset ?? undefined,
      sendUrl: row.send_url ?? undefined,
      // Migration 041. connection_count defaults to 1 in the database, and the
      // renderer omits `instances` at 1, so an untouched SMSC is unchanged.
      connectionCount: numberOrUndefined(row.connection_count),
      connectionTimeoutSeconds: numberOrUndefined(row.connection_timeout_seconds),
      waitAckExpireAction: numberOrUndefined(row.wait_ack_expire_action) as
        WaitAckExpireAction | undefined,
      // false is the column default and emits nothing; only true is carried.
      retryOnAuthFailure: row.retry_on_auth_failure ? true : undefined,
      allowedSmscIds: listOrUndefined(row.allowed_smsc_ids),
      deniedSmscIds: listOrUndefined(row.denied_smsc_ids),
      preferredSmscIds: listOrUndefined(row.preferred_smsc_ids),
      allowedPrefixes: listOrUndefined(row.allowed_prefixes),
      deniedPrefixes: listOrUndefined(row.denied_prefixes),
      preferredPrefixes: listOrUndefined(row.preferred_prefixes),
    };
  }

  /**
   * SQLBox persistence is a deployment property, not tenant state: it is
   * derived from KAMEX_SQLBOX_DATABASE_URL, the same variable docker-compose
   * hands the backend. Absent or unparseable, the pgsql-connection group is
   * omitted rather than guessed.
   */
  private sqlboxFromEnvironment(
    settings: Map<string, unknown>,
    applied: string[],
  ): EngineConfiguration['sqlbox'] | undefined {
    const raw = process.env.KAMEX_SQLBOX_DATABASE_URL;
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      const database = url.pathname.replace(/^\//, '');
      if (!url.hostname || !database) return undefined;
      return {
        enabled: true,
        // `host` is where SQLBox's POSTGRES lives; `serviceHost` is SQLBox
        // itself on the container network. Two different machines in a real
        // deployment, and conflating them is what produced the bypass bug —
        // so they are separate fields rather than one reused value.
        serviceHost: this.setting(settings, applied, GATEWAY_SETTINGS.sqlboxHost),
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database,
        usernameEnv: 'JKANNEL_SQLBOX_USER',
        passwordEnv: 'JKANNEL_SQLBOX_PASSWORD',
      };
    } catch {
      return undefined;
    }
  }
}
