import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { sha256Hex } from './identity-crypto';

interface StoredKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  allowed_ips: string[];
  rate_limit: number | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_enabled: boolean;
  created_at: Date;
}

class FakeDatabase {
  keys: StoredKey[] = [];
  audits: unknown[][] = [];
  async tenantTransaction<T>(_tenantId: string, work: (client: any) => Promise<T>): Promise<T> {
    return work({ query: (text: string, values: unknown[] = []) => this.route(text, values) });
  }
  private route(text: string, values: unknown[]) {
    if (text.startsWith('INSERT INTO api_keys')) {
      const row: StoredKey = {
        id: `key-${this.keys.length + 1}`,
        user_id: values[1] as string,
        name: values[2] as string,
        key_prefix: values[3] as string,
        key_hash: values[4] as string,
        scopes: values[5] as string[],
        allowed_ips: [],
        rate_limit: null,
        expires_at: (values[6] as Date | null) ?? null,
        last_used_at: null,
        is_enabled: true,
        created_at: new Date(),
      };
      this.keys.push(row);
      return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO audit_log')) {
      this.audits.push(values);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT') && text.includes('FROM api_keys')) {
      const owned = this.keys.filter((key) => key.user_id === values[0]);
      // Mirror the projection of the real query (no key_hash / user_id).
      const rows = owned.map((key) => ({
        id: key.id,
        name: key.name,
        key_prefix: key.key_prefix,
        scopes: key.scopes,
        allowed_ips: key.allowed_ips,
        rate_limit: key.rate_limit,
        expires_at: key.expires_at,
        last_used_at: key.last_used_at,
        is_enabled: key.is_enabled,
        created_at: key.created_at,
        __total: String(owned.length),
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith('UPDATE api_keys SET is_enabled=false')) {
      const key = this.keys.find((entry) => entry.id === values[0] && entry.user_id === values[1]);
      if (!key) return { rows: [], rowCount: 0 };
      key.is_enabled = false;
      return { rows: [{ id: key.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('ApiKeysService', () => {
  const actor = { tenantId: '1', userId: 'u1' };
  let db: FakeDatabase;
  let service: ApiKeysService;
  beforeEach(() => {
    db = new FakeDatabase();
    service = new ApiKeysService(db as never);
  });

  it('returns the full key once and stores only its hash', async () => {
    const created = await service.create(actor, { name: 'CI token', scopes: ['messages.view'] });
    expect(created.key).toMatch(/^jk_[0-9a-f]{8}\.[A-Za-z0-9_-]+$/);
    const secret = created.key.split('.')[1];
    expect(db.keys[0].key_hash).toBe(sha256Hex(secret));
    expect(db.keys[0].key_hash).not.toContain(secret);
    expect(db.audits.at(-1)).toContain('apikey.created');
  });

  it('rejects a missing name', async () => {
    await expect(service.create(actor, { scopes: [] })).rejects.toThrow(BadRequestException);
  });

  it('rejects non-string scopes', async () => {
    await expect(service.create(actor, { name: 'x', scopes: [1, 2] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lists keys as a grid without any secret', async () => {
    await service.create(actor, { name: 'one', scopes: [] });
    await service.create(actor, { name: 'two', scopes: [] });
    const page = await service.list(actor, { limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(item).not.toHaveProperty('key');
      expect(item).not.toHaveProperty('key_hash');
      expect(item.key_prefix).toBeTruthy();
    }
  });

  it('disables a key and rejects an unknown id', async () => {
    const created = await service.create(actor, { name: 'temp', scopes: [] });
    const result = await service.disable(actor, created.id);
    expect(result).toEqual({ id: created.id, disabled: true });
    expect(db.keys[0].is_enabled).toBe(false);
    await expect(service.disable(actor, 'missing')).rejects.toThrow(NotFoundException);
  });
});
