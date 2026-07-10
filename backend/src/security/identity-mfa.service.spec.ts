import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { IdentityMfaService } from './identity-mfa.service';
import { generateTotp } from './identity-totp';

interface StoredDevice {
  id: string;
  user_id: string;
  secret_encrypted: string;
  confirmed_at: Date | null;
  created_at: Date;
}

class FakeDatabase {
  devices: StoredDevice[] = [];
  recovery: Array<{ user_id: string; code_hash: string }> = [];
  async tenantTransaction<T>(_tenantId: string, work: (client: any) => Promise<T>): Promise<T> {
    return work({ query: (text: string, values: unknown[] = []) => this.route(text, values) });
  }
  private route(text: string, values: unknown[]) {
    if (/SELECT 1 FROM mfa_devices WHERE user_id=\$1 AND confirmed_at IS NOT NULL/.test(text)) {
      const rows = this.devices.filter((d) => d.user_id === values[0] && d.confirmed_at);
      return { rows: rows.map(() => ({ column: 1 })), rowCount: rows.length };
    }
    if (text.startsWith('DELETE FROM mfa_devices')) {
      this.devices = this.devices.filter((d) => d.user_id !== values[0]);
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('DELETE FROM mfa_recovery_codes')) {
      this.recovery = this.recovery.filter((r) => r.user_id !== values[0]);
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('INSERT INTO mfa_devices')) {
      this.devices.push({
        id: `d${this.devices.length + 1}`,
        user_id: values[1] as string,
        secret_encrypted: values[3] as string,
        confirmed_at: null,
        created_at: new Date(Date.now() + this.devices.length),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO mfa_recovery_codes')) {
      this.recovery.push({ user_id: values[1] as string, code_hash: values[2] as string });
      return { rows: [], rowCount: 1 };
    }
    if (/confirmed_at IS NULL ORDER BY created_at DESC/.test(text)) {
      const device = [...this.devices]
        .reverse()
        .find((d) => d.user_id === values[0] && !d.confirmed_at);
      return {
        rows: device ? [{ id: device.id, secret_encrypted: device.secret_encrypted }] : [],
        rowCount: device ? 1 : 0,
      };
    }
    if (/confirmed_at IS NOT NULL ORDER BY confirmed_at DESC/.test(text)) {
      const device = this.devices.find((d) => d.user_id === values[0] && d.confirmed_at);
      return {
        rows: device ? [{ id: device.id, secret_encrypted: device.secret_encrypted }] : [],
        rowCount: device ? 1 : 0,
      };
    }
    if (text.startsWith('UPDATE mfa_devices SET confirmed_at')) {
      const device = this.devices.find((d) => d.id === values[0]);
      if (device) device.confirmed_at = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT confirmed_at FROM mfa_devices WHERE user_id=\$1/.test(text)) {
      const rows = this.devices
        .filter((d) => d.user_id === values[0])
        .map((d) => ({ confirmed_at: d.confirmed_at }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get('secret')!;
}

describe('IdentityMfaService', () => {
  const actor = { tenantId: '1', userId: 'u1', username: 'operator' };
  let db: FakeDatabase;
  let service: IdentityMfaService;
  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = 'unit-test-mfa-encryption-key-of-40+bytes!!';
    db = new FakeDatabase();
    service = new IdentityMfaService(db as never);
  });

  it('enrolls: stores an unconfirmed device with recovery codes and returns a QR', async () => {
    const result = await service.enroll(actor);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(db.devices).toHaveLength(1);
    expect(db.devices[0].confirmed_at).toBeNull();
    expect(db.recovery).toHaveLength(10);
    expect(await service.status(actor)).toEqual({ enrolled: true, confirmed: false });
  });

  it('confirms with a valid TOTP code', async () => {
    const enrolled = await service.enroll(actor);
    const token = generateTotp(secretFromUri(enrolled.otpauthUri));
    expect(await service.confirm(actor, token)).toEqual({ confirmed: true });
    expect(await service.status(actor)).toEqual({ enrolled: true, confirmed: true });
  });

  it('rejects confirmation with a wrong code', async () => {
    await service.enroll(actor);
    await expect(service.confirm(actor, '000000')).rejects.toThrow(UnauthorizedException);
  });

  it('refuses re-enrollment while confirmed', async () => {
    const enrolled = await service.enroll(actor);
    const token = generateTotp(secretFromUri(enrolled.otpauthUri));
    await service.confirm(actor, token);
    await expect(service.enroll(actor)).rejects.toThrow(ConflictException);
  });

  it('disables MFA with a valid code', async () => {
    const enrolled = await service.enroll(actor);
    const secret = secretFromUri(enrolled.otpauthUri);
    await service.confirm(actor, generateTotp(secret));
    expect(await service.disable(actor, generateTotp(secret))).toEqual({ disabled: true });
    expect(await service.status(actor)).toEqual({ enrolled: false, confirmed: false });
  });

  it('rejects confirmation when nothing is pending', async () => {
    await expect(service.confirm(actor, '123456')).rejects.toThrow(BadRequestException);
  });
});
