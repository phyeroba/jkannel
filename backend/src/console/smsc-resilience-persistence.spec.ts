import { PoolClient } from 'pg';
import { ConsoleRepository, Actor } from './console.repository';
import { SmscController } from './console.controllers';

/**
 * Migration 041 added ten resilience/routing columns to `smsc_definitions`, and
 * `SmscService` has validated them since. `createSmsc`/`updateSmsc`, however,
 * enumerate their columns explicitly, and those ten were missing from both
 * statements — so every value an operator supplied was accepted by the API,
 * passed validation, and then **silently dropped at the INSERT**. An operator
 * could not set `connectionCount` at all: the request returned 201 and the
 * stored row still said 1.
 *
 * A param-position assertion would not have caught that, and would not catch a
 * re-introduction either: the bug was a missing COLUMN, not a wrong parameter.
 * So the fake client below does not match on substrings — it PARSES the
 * statement, binds `$n` to the supplied parameters, resolves the two COALESCE
 * shapes the repository uses, and builds the resulting row. A column absent
 * from the statement is therefore absent from the returned row, exactly as
 * PostgreSQL would leave it at its default, and the round-trip assertions fail.
 */

/** Column defaults as declared by migrations 029 and 041. */
const COLUMN_DEFAULTS: Record<string, unknown> = {
  connection_count: 1,
  connection_timeout_seconds: null,
  wait_ack_expire_action: null,
  retry_on_auth_failure: false,
  allowed_smsc_ids: [],
  denied_smsc_ids: [],
  preferred_smsc_ids: [],
  allowed_prefixes: [],
  denied_prefixes: [],
  preferred_prefixes: [],
};

const RESILIENCE_COLUMNS = Object.keys(COLUMN_DEFAULTS);

/** Strips a `::text[]`-style cast so `$38::text[]` resolves as `$38`. */
const stripCast = (token: string) => token.replace(/::[a-z_]+(\[\])?/gi, '').trim();

/**
 * Resolves one VALUES/SET expression against the bound parameters.
 * Handles the three forms the repository emits: `$n`, `COALESCE($n,literal)`
 * and `COALESCE($n,column_name)`.
 */
function resolve(
  expression: string,
  params: unknown[],
  existing: Record<string, unknown>,
): unknown {
  const text = stripCast(expression);
  const coalesce = /^COALESCE\(\s*(.+?)\s*,\s*(.+?)\s*\)$/i.exec(text);
  if (coalesce) {
    const supplied = resolve(coalesce[1], params, existing);
    if (supplied !== null && supplied !== undefined) return supplied;
    return resolve(coalesce[2], params, existing);
  }
  const placeholder = /^\$(\d+)$/.exec(text);
  if (placeholder) return params[Number(placeholder[1]) - 1] ?? null;
  if (/^'.*'$/.test(text)) {
    const literal = text.slice(1, -1);
    return literal === '{}' ? [] : literal;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text === 'now()') return 'now';
  // Anything else is a bare column reference: keep the stored value.
  return existing[text] ?? null;
}

/** Splits a comma-separated list without breaking inside parentheses. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of source) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

class FakeClient {
  /** The stored row, seeded for the UPDATE cases. */
  row: Record<string, unknown>;
  auditedDiffs: Array<{ before: unknown; after: unknown }> = [];

  constructor(seed: Record<string, unknown> = {}) {
    this.row = { id: 'smsc-1', engine_id: 'carrier-a', type: 'smpp', ...COLUMN_DEFAULTS, ...seed };
  }

  async query(rawSql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
    if (rawSql.startsWith('SELECT set_config') || rawSql === 'BEGIN' || rawSql === 'COMMIT')
      return { rows: [], rowCount: 0 };
    // `--` comments are stripped before parsing: the repository documents these
    // statements inline, and comment prose contains both commas and brackets
    // that would otherwise confuse the splitter.
    const sql = rawSql.replace(/--[^\n]*/g, ' ');

    if (sql.startsWith('SELECT * FROM smsc_definitions'))
      return { rows: [{ ...this.row }], rowCount: 1 };

    if (sql.includes('INSERT INTO smsc_definitions')) {
      const columns = splitTopLevel(
        /INSERT INTO smsc_definitions\(([\s\S]*?)\)\s*VALUES/i.exec(sql)![1],
      );
      const values = splitTopLevel(/VALUES\(([\s\S]*)\)\s*RETURNING/i.exec(sql)![1]);
      expect(values).toHaveLength(columns.length);
      // Start from the declared defaults: a column the statement omits stays
      // at its default, which is precisely the bug being pinned.
      const inserted: Record<string, unknown> = { id: 'smsc-1', ...COLUMN_DEFAULTS };
      columns.forEach((column, index) => {
        inserted[column] = resolve(values[index], params, {});
      });
      this.row = inserted;
      return { rows: [{ ...inserted }], rowCount: 1 };
    }

    if (sql.includes('UPDATE smsc_definitions SET')) {
      const assignments = splitTopLevel(
        /UPDATE smsc_definitions SET([\s\S]*?)WHERE id=\$1/i.exec(sql)![1],
      );
      const updated = { ...this.row };
      for (const assignment of assignments) {
        const stripped = assignment.replace(/--[^\n]*/g, '').trim();
        if (!stripped) continue;
        const equals = stripped.indexOf('=');
        const column = stripped.slice(0, equals).trim();
        updated[column] = resolve(stripped.slice(equals + 1), params, this.row);
      }
      this.row = updated;
      return { rows: [{ ...updated }], rowCount: 1 };
    }

    if (rawSql.includes('INSERT INTO audit_events')) {
      this.auditedDiffs.push({ before: params[5], after: params[6] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const actor: Actor = { tenantId: 'tenant-1', userId: 'user-1' };

function build(seed: Record<string, unknown> = {}) {
  const client = new FakeClient(seed);
  const database: any = {
    tenantTransaction: (_tenantId: string, work: (c: PoolClient) => Promise<unknown>) =>
      work(client as unknown as PoolClient),
  };
  return { repository: new ConsoleRepository(database), client };
}

/** The full resilience set an operator would send for a parallel-bind carrier. */
const RESILIENCE_BODY = {
  connectionCount: 8,
  connectionTimeoutSeconds: 120,
  waitAckExpireAction: 2,
  retryOnAuthFailure: true,
  allowedSmscIds: ['carrier-a', 'carrier-b'],
  preferredSmscIds: ['carrier-a'],
  allowedPrefixes: ['+2567', '+2564'],
  deniedPrefixes: ['+25670'],
  preferredPrefixes: ['+2567'],
};

describe('SMSC resilience columns (migration 041) survive create and update', () => {
  it('writes every resilience column on create', async () => {
    const { repository, client } = build();
    const row = await repository.createSmsc(actor, {
      engineId: 'carrier-a',
      name: 'Carrier A',
      type: 'smpp',
      host: 'smpp.carrier.example',
      port: 2775,
      tps: 50,
      ...RESILIENCE_BODY,
    });

    expect(row.connection_count).toBe(8);
    expect(row.connection_timeout_seconds).toBe(120);
    expect(row.wait_ack_expire_action).toBe(2);
    expect(row.retry_on_auth_failure).toBe(true);
    expect(row.allowed_smsc_ids).toEqual(['carrier-a', 'carrier-b']);
    expect(row.preferred_smsc_ids).toEqual(['carrier-a']);
    expect(row.allowed_prefixes).toEqual(['+2567', '+2564']);
    expect(row.denied_prefixes).toEqual(['+25670']);
    expect(row.preferred_prefixes).toEqual(['+2567']);
    // Not supplied, so it must land on the migration's default rather than null.
    expect(row.denied_smsc_ids).toEqual([]);
    expect(client.row.connection_count).toBe(8);
  });

  it('names every resilience column in the INSERT statement', async () => {
    // Guards the specific regression: the columns were validated and then never
    // written, because the statement simply did not mention them.
    let insert = '';
    const database: any = {
      tenantTransaction: (_t: string, work: (c: PoolClient) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            if (sql.includes('INSERT INTO smsc_definitions')) insert = sql;
            return { rows: [{ id: 'smsc-1' }], rowCount: 1 };
          },
        } as unknown as PoolClient),
    };
    await new ConsoleRepository(database).createSmsc(actor, {
      engineId: 'c',
      name: 'C',
      type: 'smpp',
      tps: 1,
    });
    for (const column of RESILIENCE_COLUMNS) expect(insert).toContain(column);
  });

  it('leaves the migration defaults in place when a caller omits them', async () => {
    const { repository } = build();
    const row = await repository.createSmsc(actor, {
      engineId: 'carrier-b',
      name: 'Carrier B',
      type: 'smpp',
      host: 'smpp.carrier.example',
      port: 2775,
      tps: 10,
    });
    expect(row.connection_count).toBe(1);
    expect(row.retry_on_auth_failure).toBe(false);
    expect(row.connection_timeout_seconds).toBeNull();
    expect(row.wait_ack_expire_action).toBeNull();
    for (const column of ['allowed_smsc_ids', 'denied_smsc_ids', 'preferred_smsc_ids'])
      expect(row[column]).toEqual([]);
  });

  it('updates resilience columns and leaves omitted ones untouched', async () => {
    const { repository } = build({
      connection_count: 4,
      retry_on_auth_failure: true,
      preferred_smsc_ids: ['carrier-a'],
      denied_prefixes: ['+25670'],
    });
    const row = await repository.updateSmsc(actor, 'smsc-1', {
      connectionCount: 16,
      connectionTimeoutSeconds: 45,
      allowedPrefixes: ['+2567'],
    });

    expect(row.connection_count).toBe(16);
    expect(row.connection_timeout_seconds).toBe(45);
    expect(row.allowed_prefixes).toEqual(['+2567']);
    // Omitted keys keep the stored value — the PATCH semantics every other
    // column on this statement already has.
    expect(row.retry_on_auth_failure).toBe(true);
    expect(row.preferred_smsc_ids).toEqual(['carrier-a']);
    expect(row.denied_prefixes).toEqual(['+25670']);
  });

  it('lets an explicit empty list clear a routing rule', async () => {
    // attributesFrom() deliberately keeps an explicit [] (it is how a caller
    // clears a rule) and drops an absent key. The UPDATE must honour that
    // distinction rather than COALESCE the empty array back to the old value.
    const { repository } = build({ preferred_smsc_ids: ['carrier-a'] });
    const row = await repository.updateSmsc(actor, 'smsc-1', { preferredSmscIds: [] });
    expect(row.preferred_smsc_ids).toEqual([]);
  });

  it('round-trips the operator request end to end through the controller', async () => {
    // The controller path is what actually broke: attributesFrom() produced the
    // values, validate() passed them, and the repository discarded them.
    const { repository, client } = build();
    const controller = new SmscController(repository);
    const created: any = await controller.create({ principal: actor } as any, {
      name: 'Carrier A',
      engineId: 'carrier-a',
      type: 'smpp',
      host: 'smpp.carrier.example',
      port: 2775,
      tps: 50,
      ...RESILIENCE_BODY,
      // Accepted as the engine's own semicolon-separated form.
      deniedSmscIds: undefined,
    });
    expect(created.connection_count).toBe(8);
    expect(created.preferred_prefixes).toEqual(['+2567']);
    expect(client.row.retry_on_auth_failure).toBe(true);
  });

  it('rejects an out-of-range connectionCount before it reaches the repository', () => {
    const repository: any = { createSmsc: jest.fn() };
    const controller = new SmscController(repository);
    expect(() =>
      controller.create({ principal: actor } as any, {
        name: 'Carrier A',
        type: 'smpp',
        host: 'h',
        port: 2775,
        tps: 5,
        connectionCount: 999,
      }),
    ).toThrow();
    expect(repository.createSmsc).not.toHaveBeenCalled();
  });
});
