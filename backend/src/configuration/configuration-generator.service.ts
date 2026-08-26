import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { collectConfigValueProblems, formatConfigValueProblem } from './config-value-safety';
import {
  InvalidSecretReferenceError,
  MissingSecretError,
  SecretResolver,
} from './secret-resolver.service';

/** SMPP bind shape. Drives `transceiver-mode` and `receive-port`. */
export type SmscBindMode = 'transceiver' | 'transmitter' | 'receiver';

/**
 * `wait-ack-expire`: what the SMPP driver does when a submit_sm_resp does not
 * arrive within `wait-ack` seconds. Values are the engine's own
 * (gw/smsc/smsc_smpp.c SMPP_WAITACK_*), not an invention of this codebase.
 */
export type WaitAckExpireAction =
  /** 0 — drop the session and rebuild the bind. */
  | 0
  /** 1 — requeue the message so any bind can carry it. Kamex's default. */
  | 1
  /** 2 — keep waiting forever. */
  | 2;

/**
 * One engine SMSC link. Mirrors the SMSC_MANAGER_SPEC_03 "Connection
 * Attributes" set and the columns added by migration 029, so a row in
 * `smsc_definitions` maps one-to-one onto this object.
 *
 * Credentials are never values: `usernameSecretRef` / `passwordSecretRef` are
 * `secret://` references that {@link SecretResolver} turns into `${ENV_NAME}`
 * placeholders at render time.
 */
export interface EngineSmsc {
  id: string;
  type: 'smpp' | 'http' | 'fake' | 'at';
  host?: string;
  port?: number;
  /** SMPP receiver-side port when bindMode is 'receiver'. */
  receivePort?: number;
  enabled: boolean;
  /** Literal SMPP system_id / HTTP account name. Ignored when usernameSecretRef is set. */
  username?: string;
  usernameSecretRef?: string;
  passwordSecretRef?: string;
  systemType?: string;
  bindMode?: SmscBindMode;
  /** SMPP interface_version: 33 (3.3), 34 (3.4) or 50 (5.0). */
  interfaceVersion?: number;
  addressRange?: string;
  sourceAddrTon?: number;
  sourceAddrNpi?: number;
  destAddrTon?: number;
  destAddrNpi?: number;
  /** SMPP window; rendered as `max-pending-submits`. */
  windowSize?: number;
  /** Messages per second; rendered as `throughput`. */
  throughput?: number;
  /** Rendered as `enquire-link-interval`. */
  keepaliveSeconds?: number;
  reconnectDelaySeconds?: number;
  /** Rendered as `wait-ack`. */
  waitAckSeconds?: number;
  maxErrorCount?: number;
  useTls?: boolean;
  altCharset?: string;
  /** HTTP adapter submit endpoint. */
  sendUrl?: string;

  // ---- Connection resilience (migration 041) --------------------------------

  /**
   * Number of parallel binds to open to this carrier, rendered as the engine's
   * `instances` directive. bearerbox (gw/bb_smscconn.c, via
   * `smscconn_instances`) creates this many connections from the single `smsc`
   * group, all carrying this `id`, and its router spreads traffic over them.
   *
   * Undefined or 1 emits nothing, so a single-bind SMSC renders exactly as it
   * did before this field existed. SMPP only — the `fake` and `http` adapters
   * open a listening socket on `port`, so a second instance would collide.
   */
  connectionCount?: number;
  /**
   * Rendered as `connection-timeout`: seconds with no PDU response after which
   * the SMPP driver declares a still-open socket dead and reconnects. This is
   * the guard against an idle bind that is dead but not closed. Undefined keeps
   * the engine's own default of 300s (10 x `enquire-link-interval`); 0 disables
   * the check entirely.
   */
  connectionTimeoutSeconds?: number;
  /** Rendered as `wait-ack-expire`. Undefined keeps the engine default (requeue). */
  waitAckExpireAction?: WaitAckExpireAction;
  /**
   * Rendered as `retry`. Without it the SMPP driver stops for good when the
   * carrier rejects the bind with an invalid system-id/password/system-type,
   * so a transient authentication fault needs an operator to clear it.
   */
  retryOnAuthFailure?: boolean;

  // ---- Declarative routing (migration 041) ----------------------------------
  // Evaluated per message by the engine's `smscconn_usable()`. Lists render as
  // semicolon-separated, double-quoted values.

  /** `allowed-smsc-id`: hard whitelist of message smsc-id values. */
  allowedSmscIds?: string[];
  /** `denied-smsc-id`: hard blacklist. Ignored by the engine when allowedSmscIds is set. */
  deniedSmscIds?: string[];
  /**
   * `preferred-smsc-id`: soft preference. A preferred link wins over a
   * non-preferred one, but a non-preferred link still carries the traffic when
   * no preferred link is usable — the engine's declarative "prefer A, fall back
   * to B".
   */
  preferredSmscIds?: string[];
  /** `allowed-prefix`: recipient MSISDN prefixes this link accepts. */
  allowedPrefixes?: string[];
  /** `denied-prefix`: recipient MSISDN prefixes this link refuses. */
  deniedPrefixes?: string[];
  /** `preferred-prefix`: recipient MSISDN prefixes this link is preferred for. */
  preferredPrefixes?: string[];
}

export interface EngineSmsbox {
  bearerboxHost: string;
  sendsmsPort: number;
  smsboxId?: string;
  globalSender?: string;
  logLevel?: 0 | 1 | 2 | 3 | 4;
}

export interface EngineSendsmsUser {
  username: string;
  passwordSecretRef: string;
  defaultSender?: string;
  /** Kannel `user-allow-ip`; '*' allows any source. */
  allowedIps?: string;
  maxMessages?: number;
  concatenation?: boolean;
  forcedSmsc?: string;
  defaultSmsc?: string;
}

export interface EngineSmsService {
  /** Kannel keyword; exactly one service must use 'default'. */
  keyword: string;
  aliases?: string[];
  /** Canned reply. Mutually exclusive with getUrl/postUrl. */
  text?: string;
  getUrl?: string;
  postUrl?: string;
  /**
   * `max-messages`: how many SMS the service's ANSWER may be split into.
   *
   * 0 is not "unlimited", it is "send no reply at all" — gw/smsbox.c
   * send_message() returns early with `info(0, "No reply sent, denied.")` when
   * urltrans_max_messages(trans) == 0. That is the only way to stop smsbox
   * turning a service's output into an outbound (billable) MT back to the
   * person who texted in, and it matters for every callback service: on a 2xx
   * the HTTP RESPONSE BODY becomes the reply SMS (url_result_thread), and on a
   * non-2xx `reply-couldnotfetch` does. A JSON API answering here would text
   * its envelope, or its error, straight back to the subscriber.
   */
  maxMessages?: number;
  concatenation?: boolean;
  catchAll?: boolean;
  omitEmpty?: boolean;
  acceptXKannelHeaders?: boolean;
  /**
   * `send-sender`: add the `X-Kannel-From` request header (the MO sender) to
   * the get-url/post-url call. Without it smsbox sends X-Kannel-To but NOT
   * X-Kannel-From — gw/smsbox.c only adds the From header behind
   * urltrans_send_sender().
   */
  sendSender?: boolean;
}

export interface EngineDlrStorage {
  /** 'internal' is the engine default (in-memory, lost on restart). */
  type: 'internal' | 'spool' | 'pgsql' | 'mysql' | 'redis';
  /** Id of the connection group backing a DB-backed store (e.g. the SQLBox pgsql-connection). */
  connectionId?: string;
  table?: string;
}

export interface EngineConfiguration {
  adminPort: number;
  smsboxPort: number;
  adminSecretRef: string;
  /** Defaults to secret://kamex/status-password, matching the shipped conf. */
  statusSecretRef?: string;
  logLevel: 0 | 1 | 2 | 3 | 4;
  sqlbox?: {
    enabled: boolean;
    /**
     * The SQLBox process's own network name — the host an smsbox must dial to
     * reach bearerbox THROUGH SQLBox. This is not cosmetic: SQLBox sits between
     * smsbox and bearerbox, and it is what writes `sent_sms`. An smsbox pointed
     * straight at bearerbox still sends every message successfully and simply
     * stops producing history, which is why this is a required field rather
     * than a defaulted one (see validate()).
     */
    serviceHost: string;
    /** PostgreSQL host backing the SQLBox tables (the pgsql-connection group). */
    host: string;
    port: number;
    database: string;
    usernameEnv: string;
    passwordEnv: string;
  };
  smsc: EngineSmsc[];
  smsbox?: EngineSmsbox;
  sendsmsUsers?: EngineSendsmsUser[];
  smsServices?: EngineSmsService[];
  dlrStorage?: EngineDlrStorage;
}

/**
 * Engines whose configuration this service can render. Today only Kamex is
 * implemented; Kannel is declared so callers (templates, drift, the console)
 * can carry an `engine` discriminator now and a future Kannel renderer can be
 * plugged into {@link ConfigurationGeneratorService.generate} without changing
 * any call site. See KANNEL_ENGINE_ADAPTER_SPECIFICATION for the target syntax.
 */
export type SupportedEngine = 'kamex' | 'kannel';
export const SUPPORTED_ENGINES: SupportedEngine[] = ['kamex', 'kannel'];

export interface GenerateOptions {
  /**
   * Abort instead of emitting placeholders when a `secret://` reference has no
   * backing environment variable. Defaults to JKANNEL_SECRETS_STRICT === 'true'
   * because in the shipped topology the carrier password lives in the engine
   * container's environment, not the backend's.
   */
  requireSecrets?: boolean;
}

export interface GeneratedConfiguration {
  content: string;
  checksum: string;
  /** Environment variables the rendered file expects the engine to supply. */
  requiredSecrets: string[];
}

const DEFAULT_STATUS_SECRET_REF = 'secret://kamex/status-password';
/** Canonical Kannel dlr-db column mapping; the engine has no defaults for these. */
const DLR_DB_FIELDS: Array<[string, string]> = [
  ['field-smsc', 'smsc'],
  ['field-timestamp', 'ts'],
  ['field-destination', 'destination'],
  ['field-source', 'source'],
  ['field-service', 'service'],
  ['field-url', 'url'],
  ['field-mask', 'mask'],
  ['field-status', 'status'],
  ['field-boxc-id', 'boxc'],
];

const isInteger = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * The SMSC-group routing list fields, paired with the engine directive each one
 * renders to. Kept as data so validation and rendering cannot drift apart.
 */
const ROUTING_LISTS: Array<[keyof EngineSmsc, string]> = [
  ['allowedSmscIds', 'allowed-smsc-id'],
  ['deniedSmscIds', 'denied-smsc-id'],
  ['preferredSmscIds', 'preferred-smsc-id'],
  ['allowedPrefixes', 'allowed-prefix'],
  ['deniedPrefixes', 'denied-prefix'],
  ['preferredPrefixes', 'preferred-prefix'],
];

/** Engine list values are semicolon separated, so an entry may not contain one. */
const LIST_SEPARATOR = ';';

@Injectable()
export class ConfigurationGeneratorService {
  // @Optional + a default so modules that have not registered SecretResolver
  // (and plain `new ConfigurationGeneratorService()` in tests) still get a
  // working, stateless env-backed resolver.
  constructor(@Optional() private readonly secrets: SecretResolver = new SecretResolver()) {}

  validate(model: EngineConfiguration): string[] {
    const errors: string[] = [];
    if (model.adminPort === model.smsboxPort) errors.push('adminPort and smsboxPort must differ');
    if (!model.adminSecretRef?.startsWith('secret://'))
      errors.push('adminSecretRef must be a secret reference');
    if (model.statusSecretRef && !model.statusSecretRef.startsWith('secret://'))
      errors.push('statusSecretRef must be a secret reference');
    if (model.sqlbox?.enabled) {
      if (!model.sqlbox.host || !model.sqlbox.database)
        errors.push('SQLBox host and database are required');
      if (!model.sqlbox.serviceHost) errors.push('SQLBox serviceHost is required');
      if (
        !/^[A-Z][A-Z0-9_]+$/.test(model.sqlbox.usernameEnv) ||
        !/^[A-Z][A-Z0-9_]+$/.test(model.sqlbox.passwordEnv)
      )
        errors.push('SQLBox credentials must be environment variable names');
    }
    const ids = new Set<string>();
    for (const smsc of model.smsc) {
      if (ids.has(smsc.id)) errors.push(`duplicate SMSC id: ${smsc.id}`);
      ids.add(smsc.id);
      if (smsc.type !== 'fake' && (!smsc.host || !smsc.port))
        errors.push(`${smsc.id} requires host and port`);
      /*
       * A `fake` SMSC needs a PORT, because bearerbox listens on it.
       *
       * This was exempted from the host/port rule above — correctly, since a
       * fake connection has no host to dial — and then nothing checked the one
       * thing it does need. The rendered group came out portless, native
       * validation accepted the file (the parser is happy; `port` is optional
       * to the GRAMMAR), and bearerbox rejected it at runtime with
       * "'port' invalid in 'fake' record" followed by "Failed to create fake
       * smsc connection". The deployment reported success and the connection
       * did not exist.
       *
       * That is the shape worth naming: native validation proves the file
       * PARSES, not that every group it contains can start. Anything the engine
       * only discovers at runtime has to be caught here instead.
       */
      // The three runtime-validity checks below apply to ENABLED links only. A
      // disabled SMSC is not
      // rendered at all, so its runtime validity cannot matter — and refusing
      // the whole deployment over a half-configured carrier somebody switched
      // off is the opposite of helpful: it makes disabling a broken link stop
      // working as the way to get a deploy out.
      if (smsc.enabled && smsc.type === 'fake' && !smsc.port)
        errors.push(`${smsc.id} is a fake SMSC and requires a port for bearerbox to listen on`);
      /*
       * An SMPP bind needs a username. Same failure shape: the file parses, and
       * the engine then logs "SMPP: Configuration file doesn't specify
       * username" and the bind never comes up.
       *
       * Either spelling satisfies it — `username` renders as `smsc-username` in
       * clear (the model builder maps the record's `system_id` onto it), and
       * `usernameSecretRef` renders the same directive as an environment
       * placeholder. They are two ways of supplying one directive, so demanding
       * a particular one would reject a valid configuration.
       */
      if (smsc.enabled && smsc.type === 'smpp' && !smsc.username && !smsc.usernameSecretRef)
        errors.push(
          `${smsc.id} is an SMPP bind and requires a system id or a username secret reference — ` +
            'without one the engine logs "Configuration file does not specify username" and never binds',
        );
      /*
       * An SMPP bind needs a SYSTEM TYPE, and this one is not like the two
       * above: it does not break the link, it stops the entire gateway.
       *
       * `smsc_smpp_create()` treats a missing `system-type` as a construction
       * failure rather than a default — it logs "SMPP: Configuration file
       * doesn't specify system-type." and returns NULL. `smsc2_start()` does not
       * skip a connection it could not build; it calls `panic()`. So one SMPP
       * carrier saved without a system type takes down every OTHER carrier too,
       * including the fake links that were already listening, and bearerbox then
       * restart-loops on the same file.
       *
       * MEASURED, and it is the reason this check exists: the local engine sat
       * in "Restarting (1)" with three healthy fake SMSCs in the same file, and
       * the only distinguishing line in a backtrace-filled log was that one
       * error. The console had accepted the carrier record with system type
       * blank, and nothing between the form and the panic disagreed.
       *
       * NATIVE VALIDATION DOES NOT CATCH THIS — verified by posting the exact
       * file that panics to the validator, which answered `valid: true`. That is
       * not a bug in the validator: it runs a real bearerbox PARSE, and the file
       * genuinely parses. `smsc2_start` runs afterwards, and by then the process
       * is the production one. Everything the engine only discovers at start has
       * to be caught here, and this is the most expensive member of that family
       * found so far.
       *
       * No default is emitted instead. "kannel" is what the HTTP renderer falls
       * back to, but on a real SMPP bind the system type is assigned by the
       * carrier and a wrong one is rejected at bind — which would trade a loud
       * failure at deploy for a quiet one at 3am against the carrier's ESME.
       */
      /*
       * ABSENT is the failure, not EMPTY.
       *
       * This used to refuse an empty string too, which is wrong: `system-type
       * = ""` is accepted by bearerbox (verified) and is what a carrier that
       * does not issue one expects. Refusing it forced operators to invent a
       * value, and an invented system type is rejected at bind with
       * ESME_RINVSYSTYP — trading a loud failure here for a quiet one against
       * the carrier's ESME.
       *
       * What must never happen is the directive being MISSING, because
       * `smsc_smpp_create()` treats that as a construction failure and
       * `smsc2_start()` panics rather than skipping the connection.
       */
      if (smsc.enabled && smsc.type === 'smpp' && smsc.systemType == null)
        errors.push(
          `${smsc.id} is an SMPP bind and needs its system type set — without the directive ` +
            'bearerbox panics on startup and takes every other SMSC down with it, not just ' +
            'this one. Use the value the carrier issued, or an empty one if they issue none; ' +
            'empty is a valid answer, absent is not.',
        );
      if (smsc.usernameSecretRef && !smsc.usernameSecretRef.startsWith('secret://'))
        errors.push(`${smsc.id} credential must be a secret reference`);
      if (smsc.passwordSecretRef && !smsc.passwordSecretRef.startsWith('secret://'))
        errors.push(`${smsc.id} password must be a secret reference`);
      errors.push(...this.validateSmscAttributes(smsc));
    }
    errors.push(...this.validateBoxes(model));
    errors.push(...this.validateRenderedValues(model));
    return errors;
  }

  /**
   * Screens every operator-supplied string that will be written into the file.
   *
   * Duplicated from the write-time check in SmscService on purpose. This is the
   * layer that covers `POST /configurations/generate?source=body`, which
   * accepts a whole EngineConfiguration from the caller and never passes
   * through the SMSC create/update path — so without it the write-time
   * validation could be walked straight around.
   */
  private validateRenderedValues(model: EngineConfiguration): string[] {
    const entries: Array<[string, unknown]> = [];
    for (const smsc of model.smsc) {
      entries.push(
        [`${smsc.id}.host`, smsc.host],
        [`${smsc.id}.id`, smsc.id],
        [`${smsc.id}.systemType`, smsc.systemType],
        [`${smsc.id}.addressRange`, smsc.addressRange],
        [`${smsc.id}.altCharset`, smsc.altCharset],
        [`${smsc.id}.sendUrl`, smsc.sendUrl],
      );
      for (const key of [
        'allowedSmscIds',
        'deniedSmscIds',
        'preferredSmscIds',
        'allowedPrefixes',
        'deniedPrefixes',
        'preferredPrefixes',
      ] as const)
        for (const [index, entry] of (smsc[key] ?? []).entries())
          entries.push([`${smsc.id}.${key}[${index}]`, entry]);
    }
    if (model.smsbox) {
      entries.push(
        ['smsbox.bearerboxHost', model.smsbox.bearerboxHost],
        ['smsbox.smsboxId', model.smsbox.smsboxId],
        ['smsbox.globalSender', model.smsbox.globalSender],
      );
    }
    for (const [index, user] of (model.sendsmsUsers ?? []).entries())
      entries.push(
        [`sendsmsUsers[${index}].username`, user.username],
        [`sendsmsUsers[${index}].allowedIps`, user.allowedIps],
        [`sendsmsUsers[${index}].defaultSmsc`, user.defaultSmsc],
        [`sendsmsUsers[${index}].forcedSmsc`, user.forcedSmsc],
        [`sendsmsUsers[${index}].defaultSender`, user.defaultSender],
      );
    for (const [index, service] of (model.smsServices ?? []).entries())
      entries.push(
        [`smsServices[${index}].keyword`, service.keyword],
        [`smsServices[${index}].aliases`, service.aliases],
        [`smsServices[${index}].text`, service.text],
        [`smsServices[${index}].getUrl`, service.getUrl],
        [`smsServices[${index}].postUrl`, service.postUrl],
      );
    return collectConfigValueProblems(entries).map(formatConfigValueProblem);
  }

  private validateSmscAttributes(smsc: EngineSmsc): string[] {
    const errors: string[] = [];
    if (smsc.bindMode && !['transceiver', 'transmitter', 'receiver'].includes(smsc.bindMode))
      errors.push(`${smsc.id} bindMode must be transceiver, transmitter or receiver`);
    if (smsc.bindMode === 'receiver' && !(smsc.receivePort ?? smsc.port))
      errors.push(`${smsc.id} receiver bind requires receivePort or port`);
    if (smsc.interfaceVersion !== undefined && ![33, 34, 50].includes(smsc.interfaceVersion))
      errors.push(`${smsc.id} interfaceVersion must be 33, 34 or 50`);
    for (const field of ['sourceAddrTon', 'sourceAddrNpi', 'destAddrTon', 'destAddrNpi'] as const) {
      const value = smsc[field];
      if (value !== undefined && !isInteger(value, 0, 255))
        errors.push(`${smsc.id} ${field} must be an integer between 0 and 255`);
    }
    if (smsc.windowSize !== undefined && !isInteger(smsc.windowSize, 1, 1000))
      errors.push(`${smsc.id} windowSize must be an integer between 1 and 1000`);
    if (
      smsc.throughput !== undefined &&
      !(typeof smsc.throughput === 'number' && smsc.throughput > 0)
    )
      errors.push(`${smsc.id} throughput must be a positive number`);
    if (smsc.keepaliveSeconds !== undefined && !isInteger(smsc.keepaliveSeconds, 0, 3600))
      errors.push(`${smsc.id} keepaliveSeconds must be an integer between 0 and 3600`);
    if (smsc.reconnectDelaySeconds !== undefined && !isInteger(smsc.reconnectDelaySeconds, 0, 3600))
      errors.push(`${smsc.id} reconnectDelaySeconds must be an integer between 0 and 3600`);
    if (smsc.waitAckSeconds !== undefined && !isInteger(smsc.waitAckSeconds, 1, 3600))
      errors.push(`${smsc.id} waitAckSeconds must be an integer between 1 and 3600`);
    errors.push(...this.validateSmscResilience(smsc));
    errors.push(...this.validateSmscRouting(smsc));
    if (smsc.type === 'http' && smsc.enabled && !smsc.sendUrl)
      errors.push(`${smsc.id} HTTP SMSC requires sendUrl`);
    // AT modems need device/speed/modemtype, which JKANNEL does not model. Say
    // so rather than emitting an smsc group the engine will reject.
    if (smsc.type === 'at' && smsc.enabled)
      errors.push(
        `${smsc.id} AT modem SMSCs cannot be rendered: the modem device, speed and ` +
          'modem type attributes are not modelled yet',
      );
    return errors;
  }

  /** Parallel-bind count and the reconnect/idle-detection attributes. */
  private validateSmscResilience(smsc: EngineSmsc): string[] {
    const errors: string[] = [];
    if (smsc.connectionCount !== undefined) {
      if (!isInteger(smsc.connectionCount, 1, 64))
        errors.push(`${smsc.id} connectionCount must be an integer between 1 and 64`);
      // The fake and http adapters bind a *listening* socket on `port`
      // (smsc_fake.c make_server_socket / smsc_http.c http_open_port), so a
      // second instance of the same group cannot start. Only an SMPP link,
      // which dials out, can be opened more than once.
      else if (smsc.connectionCount > 1 && smsc.type !== 'smpp')
        errors.push(
          `${smsc.id} connectionCount above 1 is only supported for SMPP links; ` +
            `the ${smsc.type} adapter listens on a single local port`,
        );
    }
    if (
      smsc.connectionTimeoutSeconds !== undefined &&
      !isInteger(smsc.connectionTimeoutSeconds, 0, 86400)
    )
      errors.push(`${smsc.id} connectionTimeoutSeconds must be an integer between 0 and 86400`);
    if (
      smsc.waitAckExpireAction !== undefined &&
      !([0, 1, 2] as unknown[]).includes(smsc.waitAckExpireAction)
    )
      errors.push(`${smsc.id} waitAckExpireAction must be 0, 1 or 2`);
    return errors;
  }

  /** The allowed/denied/preferred smsc-id and prefix lists. */
  private validateSmscRouting(smsc: EngineSmsc): string[] {
    const errors: string[] = [];
    for (const [field, directive] of ROUTING_LISTS) {
      const list = smsc[field] as string[] | undefined;
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        errors.push(`${smsc.id} ${String(field)} must be a list of strings`);
        continue;
      }
      for (const entry of list) {
        if (typeof entry !== 'string' || !entry.trim())
          errors.push(`${smsc.id} ${String(field)} entries must be non-empty strings`);
        else if (entry.includes(LIST_SEPARATOR))
          errors.push(
            `${smsc.id} ${String(field)} entry "${entry}" may not contain "${LIST_SEPARATOR}": ` +
              `it separates values in ${directive}`,
          );
      }
    }
    // smscconn_usable() checks allowed-smsc-id first and only falls through to
    // denied-smsc-id when allowed is unset, so setting both silently discards
    // the deny list. Say so instead of rendering a rule that does nothing.
    if (smsc.allowedSmscIds?.length && smsc.deniedSmscIds?.length)
      errors.push(
        `${smsc.id} cannot set both allowedSmscIds and deniedSmscIds: the engine ignores ` +
          'denied-smsc-id whenever allowed-smsc-id is present',
      );
    return errors;
  }

  private validateBoxes(model: EngineConfiguration): string[] {
    const errors: string[] = [];
    const users = model.sendsmsUsers ?? [];
    const services = model.smsServices ?? [];
    if ((users.length || services.length) && !model.smsbox)
      errors.push('sendsms-user and sms-service groups require an smsbox group');
    if (model.smsbox) {
      if (!model.smsbox.bearerboxHost) errors.push('smsbox.bearerboxHost is required');
      if (!isInteger(model.smsbox.sendsmsPort, 1, 65535))
        errors.push('smsbox.sendsmsPort must be a valid port');
      if (
        model.smsbox.sendsmsPort === model.adminPort ||
        model.smsbox.sendsmsPort === model.smsboxPort
      )
        errors.push('smsbox.sendsmsPort must differ from adminPort and smsboxPort');
      errors.push(...this.validateSmsboxUpstream(model));
    }
    const usernames = new Set<string>();
    for (const user of users) {
      if (!user.username) errors.push('sendsms-user username is required');
      if (usernames.has(user.username))
        errors.push(`duplicate sendsms-user username: ${user.username}`);
      usernames.add(user.username);
      if (!user.passwordSecretRef?.startsWith('secret://'))
        errors.push(`sendsms-user ${user.username} password must be a secret reference`);
    }
    if (services.length) {
      const defaults = services.filter((service) => service.keyword === 'default').length;
      if (defaults !== 1)
        errors.push('sms-service list must contain exactly one service with keyword "default"');
      for (const service of services) {
        if (!service.keyword) errors.push('sms-service keyword is required');
        const targets = [service.text, service.getUrl, service.postUrl].filter(
          (value) => value !== undefined,
        );
        if (targets.length !== 1)
          errors.push(
            `sms-service ${service.keyword} must declare exactly one of text, getUrl or postUrl`,
          );
        // gwlib/http.c parse_url() only accepts http:// and https://; anything
        // else makes smsbox log "URL <...> doesn't start with ..." once per
        // inbound message and drop the callback. Catch it here instead.
        for (const [field, value] of [
          ['getUrl', service.getUrl],
          ['postUrl', service.postUrl],
        ] as const) {
          if (value === undefined) continue;
          if (!/^https?:\/\/[^\s"]+$/.test(value))
            errors.push(
              `sms-service ${service.keyword} ${field} must be an absolute http:// or https:// URL`,
            );
        }
        if (
          (service.getUrl || service.postUrl) &&
          service.maxMessages !== 0 &&
          service.keyword === 'default'
        )
          // The default service catches everything, so its reply goes to every
          // subscriber who texts in. See EngineSmsService.maxMessages.
          errors.push(
            'sms-service default forwards to a URL, so it must set maxMessages: 0; otherwise ' +
              "the callback's response body is sent back to the sender as an SMS",
          );
      }
    }
    if (model.dlrStorage) {
      const dbBacked = ['pgsql', 'mysql'].includes(model.dlrStorage.type);
      if (dbBacked && !model.dlrStorage.connectionId)
        errors.push(`dlrStorage type ${model.dlrStorage.type} requires connectionId`);
    }
    // Secret references must map onto legal environment variable names, or the
    // rendered ${...} placeholder would be unusable.
    for (const reference of this.secretReferences(model)) {
      try {
        this.secrets.envName(reference);
      } catch (error) {
        if (error instanceof InvalidSecretReferenceError)
          errors.push(`${reference} does not map to an environment variable name`);
        else throw error;
      }
    }
    return errors;
  }

  /**
   * THE SMSBOX MUST NOT BE ABLE TO BYPASS SQLBOX.
   *
   * `bearerbox-host` in the smsbox group is misleadingly named: it is "the host
   * this smsbox connects to", and in a SQLBox topology that host is SQLBox, not
   * bearerbox. SQLBox is a transparent proxy — it speaks the boxc protocol on
   * both sides — so an smsbox wired straight to bearerbox works perfectly:
   * messages are accepted, sent and delivered. The only thing that changes is
   * that nothing writes `sent_sms` any more, because SQLBox is what writes it.
   * Message history stops accumulating and NOTHING reports an error. The MO
   * ingest sweep (messaging-depth/mo-inbound.service.ts) reads that same table,
   * so inbound ingestion silently dies with it.
   *
   * A failure that is invisible cannot be defended by a better default, so it
   * is not defended by one: when the model says SQLBox is deployed, a
   * `bearerboxHost` that is not SQLBox is a validation ERROR and generate()
   * refuses to render. The wrong answer is unreachable, not merely unlikely.
   */
  private validateSmsboxUpstream(model: EngineConfiguration): string[] {
    const smsbox = model.smsbox;
    const sqlbox = model.sqlbox;
    if (!smsbox || !sqlbox?.enabled || !sqlbox.serviceHost) return [];
    if (smsbox.bearerboxHost === sqlbox.serviceHost) return [];
    return [
      `smsbox.bearerboxHost is "${smsbox.bearerboxHost}" but SQLBox ("${sqlbox.serviceHost}") ` +
        'is deployed between smsbox and bearerbox: this configuration would bypass SQLBox, ' +
        'and message history (sent_sms) plus MO ingest would stop without any error. ' +
        `Set it to "${sqlbox.serviceHost}".`,
    ];
  }

  /** Every `secret://` reference the model carries, in render order. */
  private secretReferences(model: EngineConfiguration): string[] {
    const references: string[] = [];
    const add = (value?: string) => {
      if (value?.startsWith('secret://')) references.push(value);
    };
    add(model.adminSecretRef);
    add(model.statusSecretRef ?? DEFAULT_STATUS_SECRET_REF);
    // Disabled SMSCs are not rendered, so their credentials are not required.
    for (const smsc of model.smsc.filter((entry) => entry.enabled)) {
      add(smsc.usernameSecretRef);
      add(smsc.passwordSecretRef);
    }
    for (const user of model.sendsmsUsers ?? []) add(user.passwordSecretRef);
    return references;
  }

  /**
   * Renders a validated EngineConfiguration for the target engine. `engine` is
   * a parameter (default 'kamex') so the render step is a per-engine strategy:
   * new engines add a private renderer and a switch arm here — no call site
   * changes. Unsupported/not-yet-implemented engines fail loudly rather than
   * silently emitting the wrong syntax.
   */
  generate(
    model: EngineConfiguration,
    engine: SupportedEngine = 'kamex',
    options: GenerateOptions = {},
  ): GeneratedConfiguration {
    const errors = this.validate(model);
    if (errors.length) throw new Error(errors.join('; '));
    const references = this.secretReferences(model);
    if (options.requireSecrets ?? this.secrets.strictByDefault)
      // Throws MissingSecretError naming the reference and the environment
      // variable — never the value.
      this.secrets.assertResolvable(references);
    switch (engine) {
      case 'kamex':
        return this.renderKamex(model, references);
      case 'kannel':
        // Structural hook only: the Kannel renderer is intentionally not built
        // here. A future implementation replaces this arm with renderKannel().
        throw new Error(
          'Kannel configuration rendering is not implemented yet; only "kamex" is supported',
        );
      default:
        throw new Error(`Unsupported engine: ${String(engine)}`);
    }
  }

  private renderKamex(model: EngineConfiguration, references: string[]): GeneratedConfiguration {
    const lines: string[] = [];
    const push = (key: string, value: string | number | boolean | undefined) => {
      if (value === undefined || value === null || value === '') return;
      lines.push(`${key} = ${typeof value === 'boolean' ? (value ? 'true' : 'false') : value}`);
    };
    const quoted = (key: string, value: string | undefined) => {
      if (value === undefined || value === '') return;
      // Backslash FIRST, then quote — reversing the order would re-escape the
      // backslashes this step introduces. Escaping `\` at all matters because
      // the engine's parser unescapes `\"`, so a value ending in a backslash
      // would otherwise escape its own closing quote and the parser would read
      // on into the following line.
      //
      // Belt and braces: validateRenderedValues() already rejects both
      // characters, so in practice nothing reaches here needing it. Correct
      // escaping is kept anyway so the emitter is not silently depending on a
      // validator somewhere else being exhaustive.
      lines.push(`${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    };

    lines.push('# Generated by JKANNEL. Do not edit by hand.');
    lines.push('# Credentials appear only as ${ENV} placeholders resolved by the engine runtime.');
    lines.push('group = core');
    push('admin-port', model.adminPort);
    push('smsbox-port', model.smsboxPort);
    push('admin-password', this.secrets.placeholder(model.adminSecretRef));
    push(
      'status-password',
      this.secrets.placeholder(model.statusSecretRef ?? DEFAULT_STATUS_SECRET_REF),
    );
    push('log-level', model.logLevel);
    push('log-format', 'json');
    if (model.dlrStorage) push('dlr-storage', model.dlrStorage.type);

    for (const smsc of [...model.smsc]
      .filter((entry) => entry.enabled)
      .sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push('');
      lines.push('group = smsc');
      push('smsc', smsc.type);
      push('smsc-id', smsc.id);
      // One group, N binds. Omitted at 1 so a single-connection SMSC keeps its
      // existing byte-for-byte output.
      if ((smsc.connectionCount ?? 1) > 1) push('instances', smsc.connectionCount);
      push('host', smsc.host);
      push('port', smsc.port);
      if (smsc.type === 'smpp') this.renderSmppSmsc(smsc, push);
      if (smsc.type === 'http') this.renderHttpSmsc(smsc, push, quoted);
      // Generic directives valid for every adapter.
      push('throughput', smsc.throughput);
      push('reconnect-delay', smsc.reconnectDelaySeconds);
      push('max-error-count', smsc.maxErrorCount);
      push('alt-charset', smsc.altCharset);
      this.renderSmscRouting(smsc, quoted);
    }

    if (model.smsbox) {
      lines.push('');
      lines.push('group = smsbox');
      // "bearerbox-host" = the host this smsbox dials. With SQLBox deployed
      // that is SQLBox, which then relays to bearerbox; validateSmsboxUpstream()
      // refuses to render anything else.
      push('bearerbox-host', model.smsbox.bearerboxHost);
      push('sendsms-port', model.smsbox.sendsmsPort);
      push('smsbox-id', model.smsbox.smsboxId);
      push('global-sender', model.smsbox.globalSender);
      push('log-level', model.smsbox.logLevel ?? model.logLevel);
      push('log-format', 'json');
    }

    for (const user of [...(model.sendsmsUsers ?? [])].sort((a, b) =>
      a.username.localeCompare(b.username),
    )) {
      lines.push('');
      lines.push('group = sendsms-user');
      push('username', user.username);
      push('password', this.secrets.placeholder(user.passwordSecretRef));
      push('user-allow-ip', user.allowedIps);
      push('default-sender', user.defaultSender);
      push('max-messages', user.maxMessages);
      push('concatenation', user.concatenation);
      push('forced-smsc', user.forcedSmsc);
      push('default-smsc', user.defaultSmsc);
    }

    // 'default' last: it is the catch-all keyword and reads naturally at the end.
    for (const service of [...(model.smsServices ?? [])].sort((a, b) =>
      a.keyword === 'default'
        ? 1
        : b.keyword === 'default'
          ? -1
          : a.keyword.localeCompare(b.keyword),
    )) {
      lines.push('');
      lines.push('group = sms-service');
      push('keyword', service.keyword);
      if (service.aliases?.length) push('aliases', service.aliases.join(';'));
      quoted('text', service.text);
      quoted('get-url', service.getUrl);
      quoted('post-url', service.postUrl);
      push('max-messages', service.maxMessages);
      push('concatenation', service.concatenation);
      push('catch-all', service.catchAll);
      push('omit-empty', service.omitEmpty);
      push('accept-x-kannel-headers', service.acceptXKannelHeaders);
      push('send-sender', service.sendSender);
    }

    if (model.sqlbox?.enabled) {
      lines.push('');
      lines.push('# SQLBox PostgreSQL connection (consumed by the SQLBox process)');
      lines.push('group = pgsql-connection');
      push('id', 'jkannel-sqlbox');
      push('host', model.sqlbox.host);
      push('port', model.sqlbox.port);
      push('database', model.sqlbox.database);
      push('username', `\${${model.sqlbox.usernameEnv}}`);
      push('password', `\${${model.sqlbox.passwordEnv}}`);
    }

    if (model.dlrStorage && ['pgsql', 'mysql'].includes(model.dlrStorage.type)) {
      lines.push('');
      lines.push('# Delivery report persistence (survives an engine restart)');
      lines.push('group = dlr-db');
      push('id', model.dlrStorage.connectionId);
      push('table', model.dlrStorage.table ?? 'dlr');
      for (const [key, value] of DLR_DB_FIELDS) push(key, value);
    }

    const content = `${lines.join('\n')}\n`;
    const requiredSecrets = [...new Set(references.map((ref) => this.secrets.envName(ref)))].sort();
    return {
      content,
      checksum: createHash('sha256').update(content).digest('hex'),
      requiredSecrets,
    };
  }

  private renderSmppSmsc(
    smsc: EngineSmsc,
    push: (key: string, value: string | number | boolean | undefined) => void,
  ) {
    const bindMode = smsc.bindMode ?? 'transceiver';
    if (bindMode === 'receiver') push('receive-port', smsc.receivePort ?? smsc.port);
    else if (smsc.receivePort) push('receive-port', smsc.receivePort);
    push(
      'smsc-username',
      smsc.usernameSecretRef ? this.secrets.placeholder(smsc.usernameSecretRef) : smsc.username,
    );
    if (smsc.passwordSecretRef)
      push('smsc-password', this.secrets.placeholder(smsc.passwordSecretRef));
    /*
     * An EMPTY system type is a real answer, not a missing one.
     *
     * SMPP's `system_type` is an optional field and plenty of carriers expect
     * it blank — the one being brought up on 2026-08-27 supplied a system id
     * and password and no system type at all. `push` drops empty strings, so
     * an operator who deliberately wants a blank one could not express it, and
     * the guard in `validate()` refused the record outright. Between them they
     * forced a value the carrier may reject with ESME_RINVSYSTYP.
     *
     * Verified against a real bearerbox: `system-type = ""` starts cleanly and
     * draws no complaint. So the DIRECTIVE must be present — its absence is
     * what panics `smsc2_start` — while its VALUE may be empty.
     */
    // `push` drops an empty string, so an explicitly empty system type is sent
    // as the two-character literal `""` — which is what the directive needs to
    // look like in the file, and keeps this to the one emitter in scope here.
    push('system-type', smsc.systemType === '' ? '""' : smsc.systemType);
    push('interface-version', smsc.interfaceVersion);
    push('address-range', smsc.addressRange);
    push('transceiver-mode', bindMode === 'transceiver' ? 1 : 0);
    push('source-addr-ton', smsc.sourceAddrTon);
    push('source-addr-npi', smsc.sourceAddrNpi);
    push('dest-addr-ton', smsc.destAddrTon);
    push('dest-addr-npi', smsc.destAddrNpi);
    push('max-pending-submits', smsc.windowSize);
    // Liveness. enquire-link-interval is the SMPP keepalive; connection-timeout
    // is the "no response at all for this long, the socket is dead even though
    // it is open" guard that actually triggers the reconnect. reconnect-delay
    // (emitted generically below) then paces the retry loop.
    push('enquire-link-interval', smsc.keepaliveSeconds);
    push('wait-ack', smsc.waitAckSeconds);
    push('wait-ack-expire', smsc.waitAckExpireAction);
    push('connection-timeout', smsc.connectionTimeoutSeconds);
    if (smsc.retryOnAuthFailure) push('retry', true);
    if (smsc.useTls) push('use-ssl', true);
  }

  /**
   * Emits the SMSC-group routing directives. All are optional and omitted when
   * empty, so an SMSC that does not use them renders unchanged.
   *
   * ---------------------------------------------------------------------------
   * DESIGN NOTE — retrying a message on another bind after a *delivery* failure
   * ---------------------------------------------------------------------------
   * This is deliberately NOT implemented, here or anywhere else yet. Two
   * different failures get confused with each other, so to be precise:
   *
   * 1. Submit-time failure (the bind is down, or the carrier never acks the
   *    submit_sm). Already handled, at two levels. The engine requeues on
   *    `wait-ack` expiry (`wait-ack-expire` = 1, the Kamex default) and dumps a
   *    reconnecting link's queue back to the global queue so a sibling bind
   *    picks it up; `preferred-smsc-id` and the `instances` count above decide
   *    which. Above that, JKANNEL's own `MessageSendService` picks only from
   *    `availableSmscIds` derived from live bind state and falls back per route.
   *
   * 2. Delivery failure — the submit succeeded and a *negative DLR* arrives
   *    later (SMPP UNDELIV / REJECTD / EXPIRED). The engine cannot retry this:
   *    by the time the DLR lands, the message is long gone from bearerbox. It
   *    is a control-plane job, and it belongs in the messaging module, not in
   *    the configuration generator. What it needs:
   *
   *      - A DLR watcher keyed on terminal-failure statuses only. Success and
   *        intermediate/BUFFRED statuses must not trigger anything, and the
   *        watcher must read the delivery record, not the raw DLR, so a
   *        duplicate DLR cannot start a second retry.
   *      - A retry policy per route or per customer: max attempts, and a
   *        backoff (exponential with jitter) measured from the DLR timestamp,
   *        not the submit. Attempts must be persisted on the message so a
   *        control-plane restart neither loses nor repeats them.
   *      - Alternate-bind selection: exclude the bind that just failed, then
   *        re-run the normal route resolution over the remaining available
   *        binds. If none is left, stop and surface the failure — never fall
   *        back to the same carrier that produced the permanent failure.
   *      - Loop protection: a permanent per-destination failure (unroutable
   *        number, blacklisted MSISDN) must be classified as non-retryable and
   *        suppressed, plus a per-destination circuit breaker so one dead
   *        number cannot consume the retry budget forever. Every retry needs to
   *        be linked to the original message id for billing and audit, so one
   *        logical send is never charged or reported as several.
   *
   * Until that exists, a negative DLR is recorded and surfaced, and nothing
   * resends it.
   */
  private renderSmscRouting(
    smsc: EngineSmsc,
    quoted: (key: string, value: string | undefined) => void,
  ) {
    for (const [field, directive] of ROUTING_LISTS) {
      const list = smsc[field] as string[] | undefined;
      if (list?.length) quoted(directive, list.join(LIST_SEPARATOR));
    }
  }

  private renderHttpSmsc(
    smsc: EngineSmsc,
    push: (key: string, value: string | number | boolean | undefined) => void,
    quoted: (key: string, value: string | undefined) => void,
  ) {
    push('system-type', smsc.systemType ?? 'kannel');
    quoted('send-url', smsc.sendUrl);
    push(
      'username',
      smsc.usernameSecretRef ? this.secrets.placeholder(smsc.usernameSecretRef) : smsc.username,
    );
    if (smsc.passwordSecretRef) push('password', this.secrets.placeholder(smsc.passwordSecretRef));
  }
}

export { MissingSecretError, SecretResolver };
