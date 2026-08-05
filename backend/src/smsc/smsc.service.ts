import { Injectable } from '@nestjs/common';
export type SmscType = 'smpp' | 'http' | 'fake' | 'at';
export type SmscBindMode = 'transceiver' | 'transmitter' | 'receiver';

/**
 * The SMSC connection attributes SMSC_MANAGER_SPEC_03 requires, mirroring the
 * columns added by migration 029. Everything here is optional: the database
 * supplies engine-compatible defaults, and an operator only overrides what the
 * carrier asks for.
 */
export interface SmscAttributes {
  systemId?: string;
  usernameSecretRef?: string;
  systemType?: string;
  bindMode?: SmscBindMode;
  receivePort?: number;
  interfaceVersion?: number;
  addressRange?: string;
  sourceAddrTon?: number;
  sourceAddrNpi?: number;
  destAddrTon?: number;
  destAddrNpi?: number;
  windowSize?: number;
  keepaliveSeconds?: number;
  reconnectDelaySeconds?: number;
  waitAckSeconds?: number;
  maxErrorCount?: number;
  useTls?: boolean;
  altCharset?: string;
  sendUrl?: string;
  notes?: string;

  /**
   * Connection resilience and declarative routing (migration 041). See
   * {@link EngineSmsc} in the configuration module for the engine directive
   * each of these renders to.
   */
  connectionCount?: number;
  connectionTimeoutSeconds?: number;
  waitAckExpireAction?: number;
  retryOnAuthFailure?: boolean;
  allowedSmscIds?: string[];
  deniedSmscIds?: string[];
  preferredSmscIds?: string[];
  allowedPrefixes?: string[];
  deniedPrefixes?: string[];
  preferredPrefixes?: string[];
}

/** Attribute keys holding a semicolon-separated engine routing list. */
const ROUTING_LIST_KEYS = [
  'allowedSmscIds',
  'deniedSmscIds',
  'preferredSmscIds',
  'allowedPrefixes',
  'deniedPrefixes',
  'preferredPrefixes',
] as const;

export interface SmscDefinition extends SmscAttributes {
  id: string;
  name: string;
  type: SmscType;
  host?: string;
  port?: number;
  /** secret:// reference for the bind password. Never a literal value. */
  credentialSecretRef?: string;
  tps: number;
  enabled: boolean;
}

const BIND_MODES: SmscBindMode[] = ['transceiver', 'transmitter', 'receiver'];
const isInteger = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Numeric attribute ranges, kept in step with the CHECK constraints in migration 029. */
const NUMERIC_RANGES: Array<[keyof SmscAttributes, number, number]> = [
  ['receivePort', 1, 65535],
  ['sourceAddrTon', 0, 255],
  ['sourceAddrNpi', 0, 255],
  ['destAddrTon', 0, 255],
  ['destAddrNpi', 0, 255],
  ['windowSize', 1, 1000],
  ['keepaliveSeconds', 0, 3600],
  ['reconnectDelaySeconds', 0, 3600],
  ['waitAckSeconds', 1, 3600],
  ['maxErrorCount', 0, 100000],
  // Migration 041. Ranges match the CHECK constraints in 041_smsc_resilience.
  ['connectionCount', 1, 64],
  ['connectionTimeoutSeconds', 0, 86400],
  ['waitAckExpireAction', 0, 2],
];

@Injectable()
export class SmscService {
  validate(value: SmscDefinition): string[] {
    const errors: string[] = [];
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value.id)) errors.push('invalid id');
    if (value.tps <= 0 || value.tps > 100000) errors.push('invalid TPS');
    if (value.type !== 'fake' && (!value.host || !value.port))
      errors.push('host and port required');
    if (value.credentialSecretRef && !value.credentialSecretRef.startsWith('secret://'))
      errors.push('credential must be a secret reference');
    if (value.usernameSecretRef && !value.usernameSecretRef.startsWith('secret://'))
      errors.push('username secret must be a secret reference');
    if (value.bindMode && !BIND_MODES.includes(value.bindMode))
      errors.push(`bindMode must be one of ${BIND_MODES.join(', ')}`);
    if (value.interfaceVersion !== undefined && ![33, 34, 50].includes(value.interfaceVersion))
      errors.push('interfaceVersion must be 33, 34 or 50');
    for (const [field, min, max] of NUMERIC_RANGES) {
      const attribute = value[field];
      if (attribute !== undefined && !isInteger(attribute, min, max))
        errors.push(`${field} must be an integer between ${min} and ${max}`);
    }
    if (value.type === 'http' && value.sendUrl && !/^https?:\/\//.test(value.sendUrl))
      errors.push('sendUrl must be an http(s) URL');
    // Parallel binds are an SMPP-only capability: the fake and http adapters
    // open a listening socket on `port`, so a second instance cannot start.
    if (value.connectionCount !== undefined && value.connectionCount > 1 && value.type !== 'smpp')
      errors.push('connectionCount above 1 is only supported for SMPP links');
    for (const key of ROUTING_LIST_KEYS) {
      const list = value[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((e) => typeof e !== 'string' || !e.trim()))
        errors.push(`${key} must be a list of non-empty strings`);
      else if (list.some((e) => e.includes(';')))
        errors.push(`${key} entries may not contain ";", which separates values in the engine`);
    }
    if (value.allowedSmscIds?.length && value.deniedSmscIds?.length)
      errors.push('allowedSmscIds and deniedSmscIds are mutually exclusive');
    return errors;
  }
  assertValid(value: SmscDefinition): SmscDefinition {
    const errors = this.validate(value);
    if (errors.length) throw new Error(errors.join('; '));
    return Object.freeze({ ...value });
  }

  /**
   * Coerces a raw request body into the typed attribute set, dropping absent
   * keys so a PATCH does not overwrite stored values with nulls. Type errors
   * are left to {@link validate}: anything non-numeric is passed through as-is
   * so the caller receives a field-named error rather than a silent NaN.
   */
  attributesFrom(body: Record<string, unknown>): SmscAttributes {
    const attributes: Record<string, unknown> = {};
    const copyString = (key: keyof SmscAttributes) => {
      const value = body[key];
      if (typeof value === 'string' && value.trim()) attributes[key] = value.trim();
    };
    const copyNumber = (key: keyof SmscAttributes) => {
      const value = body[key];
      if (value === undefined || value === null || value === '') return;
      const parsed = typeof value === 'number' ? value : Number(value);
      attributes[key] = Number.isFinite(parsed) ? parsed : value;
    };
    for (const key of [
      'systemId',
      'usernameSecretRef',
      'systemType',
      'addressRange',
      'altCharset',
      'sendUrl',
      'notes',
    ] as const)
      copyString(key);
    if (typeof body.bindMode === 'string') attributes.bindMode = body.bindMode;
    for (const key of [
      'receivePort',
      'interfaceVersion',
      'sourceAddrTon',
      'sourceAddrNpi',
      'destAddrTon',
      'destAddrNpi',
      'windowSize',
      'keepaliveSeconds',
      'reconnectDelaySeconds',
      'waitAckSeconds',
      'maxErrorCount',
      'connectionCount',
      'connectionTimeoutSeconds',
      'waitAckExpireAction',
    ] as const)
      copyNumber(key);
    if (typeof body.useTls === 'boolean') attributes.useTls = body.useTls;
    if (typeof body.retryOnAuthFailure === 'boolean')
      attributes.retryOnAuthFailure = body.retryOnAuthFailure;
    // Routing lists accept either an array or the engine's own semicolon-
    // separated string, so an operator can paste a value straight from a
    // carrier's instructions. An explicit empty list is kept: it is how a
    // caller clears a rule, and is distinct from omitting the key.
    for (const key of ROUTING_LIST_KEYS) {
      const raw = body[key];
      // Non-string members are passed through so validate() names the field
      // rather than silently dropping them.
      if (Array.isArray(raw)) attributes[key] = raw;
      else if (typeof raw === 'string')
        attributes[key] = raw
          .split(';')
          .map((entry) => entry.trim())
          .filter(Boolean);
    }
    return attributes;
  }
}
