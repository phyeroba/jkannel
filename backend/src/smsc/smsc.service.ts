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
}

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
    ] as const)
      copyNumber(key);
    if (typeof body.useTls === 'boolean') attributes.useTls = body.useTls;
    return attributes;
  }
}
