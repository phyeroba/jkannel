import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  InvalidSecretReferenceError,
  MissingSecretError,
  SecretResolver,
} from './secret-resolver.service';

/** SMPP bind shape. Drives `transceiver-mode` and `receive-port`. */
export type SmscBindMode = 'transceiver' | 'transmitter' | 'receiver';

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
  maxMessages?: number;
  concatenation?: boolean;
  catchAll?: boolean;
  omitEmpty?: boolean;
  acceptXKannelHeaders?: boolean;
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
      if (smsc.usernameSecretRef && !smsc.usernameSecretRef.startsWith('secret://'))
        errors.push(`${smsc.id} credential must be a secret reference`);
      if (smsc.passwordSecretRef && !smsc.passwordSecretRef.startsWith('secret://'))
        errors.push(`${smsc.id} password must be a secret reference`);
      errors.push(...this.validateSmscAttributes(smsc));
    }
    errors.push(...this.validateBoxes(model));
    return errors;
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
      lines.push(`${key} = "${value.replace(/"/g, '\\"')}"`);
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
      push('host', smsc.host);
      push('port', smsc.port);
      if (smsc.type === 'smpp') this.renderSmppSmsc(smsc, push);
      if (smsc.type === 'http') this.renderHttpSmsc(smsc, push, quoted);
      // Generic directives valid for every adapter.
      push('throughput', smsc.throughput);
      push('reconnect-delay', smsc.reconnectDelaySeconds);
      push('max-error-count', smsc.maxErrorCount);
      push('alt-charset', smsc.altCharset);
    }

    if (model.smsbox) {
      lines.push('');
      lines.push('group = smsbox');
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
    push('system-type', smsc.systemType);
    push('interface-version', smsc.interfaceVersion);
    push('address-range', smsc.addressRange);
    push('transceiver-mode', bindMode === 'transceiver' ? 1 : 0);
    push('source-addr-ton', smsc.sourceAddrTon);
    push('source-addr-npi', smsc.sourceAddrNpi);
    push('dest-addr-ton', smsc.destAddrTon);
    push('dest-addr-npi', smsc.destAddrNpi);
    push('max-pending-submits', smsc.windowSize);
    push('enquire-link-interval', smsc.keepaliveSeconds);
    push('wait-ack', smsc.waitAckSeconds);
    if (smsc.useTls) push('use-ssl', true);
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
