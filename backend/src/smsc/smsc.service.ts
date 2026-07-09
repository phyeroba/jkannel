import { Injectable } from '@nestjs/common';
export type SmscType = 'smpp' | 'http' | 'fake' | 'at';
export interface SmscDefinition {
  id: string;
  name: string;
  type: SmscType;
  host?: string;
  port?: number;
  credentialSecretRef?: string;
  tps: number;
  enabled: boolean;
}
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
    return errors;
  }
  assertValid(value: SmscDefinition): SmscDefinition {
    const errors = this.validate(value);
    if (errors.length) throw new Error(errors.join('; '));
    return Object.freeze({ ...value });
  }
}
