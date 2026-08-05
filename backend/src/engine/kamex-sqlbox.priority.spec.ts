import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  KamexSqlboxRepository,
  MESSAGE_PRIORITY_MAX,
  MESSAGE_PRIORITY_MIN,
  parseMessagePriority,
} from './kamex-sqlbox.repository';

/**
 * Message priority, end to end on the JKANNEL side.
 *
 * THE HISTORY MATTERS, because this file used to assert the exact opposite.
 * Stock sqlbox's PostgreSQL driver never named `priority` in its SELECT
 * (`SQLBOX_PGSQL_SELECT_QUERY` in addons/sqlbox/gw/sqlbox_pgsql.h listed 27
 * columns without it, and the string appeared nowhere in sqlbox_pgsql.c), so a
 * priority column on `send_sms` would have been written, displayed, and read by
 * nothing. The MySQL driver in the same upstream tree always carried it, which
 * is what proved this was a driver gap rather than an engine limitation.
 *
 * infrastructure/kannel/sqlbox/Dockerfile now closes that gap at image-build
 * time, so the column is meaningful and these tests pin the working behaviour
 * instead of the deliberate absence. The last describe() below pins the
 * Dockerfile patch itself: deleting it would otherwise silently return
 * `priority` to being an inert field, which is the failure mode this whole
 * exercise exists to prevent.
 *
 * WHAT PRIORITY DOES, stated the same way here as everywhere else: it orders
 * bearerbox's per-SMSC outbound queue, so it only matters when a backlog
 * exists. On an idle link with a sub-second drain nothing observable changes.
 */

/** Captures the SQL `submit()` issues, without needing a database. */
function capture() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const pool: any = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return { rows: [{ sql_id: '4242' }], rowCount: 1 };
    },
  };
  const repository = new KamexSqlboxRepository();
  (repository as any).pool = pool;
  return { repository, statements };
}

const BASE = { sender: '+256700000001', receiver: '+256700000002', text: 'hi' };

const insertOf = (statements: Array<{ sql: string; params: unknown[] }>) =>
  statements.find((statement) => statement.sql.includes('INSERT INTO send_sms'))!;

describe('priority validation', () => {
  it.each([0, 1, 2, 3])('accepts %s, the range the engine puts on the wire', (value) => {
    expect(parseMessagePriority(value)).toBe(value);
  });

  it('treats absent, null and empty string as "no preference"', () => {
    expect(parseMessagePriority(undefined)).toBeNull();
    expect(parseMessagePriority(null)).toBeNull();
    expect(parseMessagePriority('')).toBeNull();
  });

  it('accepts the numeric string a query string or form body would supply', () => {
    expect(parseMessagePriority('2')).toBe(2);
    expect(parseMessagePriority(' 3 ')).toBe(3);
  });

  it.each([-1, 4, 5, 1.5, Number.NaN, Infinity, 'high', {}, [], [2], true, false])(
    'rejects %p with a 400 naming the range',
    (value) => {
      expect(() => parseMessagePriority(value)).toThrow(BadRequestException);
      try {
        parseMessagePriority(value);
      } catch (error) {
        // smsc_smpp.c:1154 silently ignores anything outside 0-3, so the API
        // must reject it rather than let it become a no-op.
        expect((error as Error).message).toContain(
          `between ${MESSAGE_PRIORITY_MIN} and ${MESSAGE_PRIORITY_MAX}`,
        );
      }
    },
  );

  it('names the offending field, so a bulk row can say which one', () => {
    expect(() => parseMessagePriority(9, 'rows[3].priority')).toThrow(/rows\[3\]\.priority/);
  });
});

describe('priority reaches the send_sms INSERT', () => {
  it('writes the value as the priority column', async () => {
    const { repository, statements } = capture();
    const result = await repository.submit({ ...BASE, priority: 3 });

    const insert = insertOf(statements);
    expect(insert.sql).toMatch(/INSERT INTO send_sms\([^)]*\bpriority\b/);
    expect(insert.params).toContain(3);
    expect(result.priority).toBe(3);
    expect(result.sqlId).toBe('4242');
  });

  it('writes 0 as 0, not as "unset"', async () => {
    // 0 is a real SMPP priority level (normal/bulk); conflating it with NULL
    // would make "explicitly deprioritise this replay" impossible to express.
    const { repository, statements } = capture();
    const result = await repository.submit({ ...BASE, priority: 0 });
    expect(insertOf(statements).params.at(-1)).toBe(0);
    expect(result.priority).toBe(0);
  });

  it('writes NULL when no priority is given, which is exactly today’s behaviour', async () => {
    // The driver decodes a NULL column as MSG_PARAM_UNDEFINED (-1), the value
    // every message carried before this column existed. The default path must
    // not change.
    const { repository, statements } = capture();
    const result = await repository.submit(BASE);
    const insert = insertOf(statements);
    expect(insert.params.at(-1)).toBeNull();
    expect(result.priority).toBeNull();
    // Everything else about the default submission is unchanged.
    expect(insert.params).toEqual([
      BASE.sender,
      BASE.receiver,
      BASE.text,
      null,
      31,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(result).toMatchObject({
      status: 'queued',
      source: 'kamex-sqlbox',
      deferredMinutes: null,
      validityMinutes: null,
    });
  });

  it('refuses an out-of-range priority before issuing any SQL', async () => {
    const { repository, statements } = capture();
    await expect(repository.submit({ ...BASE, priority: 7 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(statements).toHaveLength(0);
  });

  it('keeps the INSERT placeholder count in step with its column list', async () => {
    const { repository, statements } = capture();
    await repository.submit({ ...BASE, priority: 1 });
    const insert = insertOf(statements);
    const columns = insert.sql.match(/INSERT INTO send_sms\(([^)]*)\)/)![1].split(',');
    const placeholders = new Set(insert.sql.match(/\$\d+/g));
    // momt is a literal 'MT' and time is an expression; the rest are bound.
    expect(columns).toContain('priority');
    expect(placeholders.size).toBe(insert.params.length);
  });
});

describe('priority is visible on message records', () => {
  function rows(row: Record<string, unknown>) {
    const pool: any = { query: async () => ({ rows: [row], rowCount: 1 }) };
    const repository = new KamexSqlboxRepository();
    (repository as any).pool = pool;
    return repository;
  }

  const engineRow = (priority: unknown) => ({
    sql_id: 1,
    momt: 'MT',
    sender: 'JKANNEL',
    receiver: '+256700000002',
    msgdata: 'hi',
    time: 1_700_000_000,
    smsc_id: 'carrier-a',
    priority,
  });

  it('surfaces what the row was actually sent at', async () => {
    const repository = rows(engineRow(3));
    const [item] = (await repository.list({ allowedSmscIds: ['carrier-a'] })).items as any[];
    expect(item.priority).toBe(3);
  });

  it('reports an unset priority as null, never as 0', async () => {
    const repository = rows(engineRow(null));
    const [item] = (await repository.list({ allowedSmscIds: ['carrier-a'] })).items as any[];
    expect(item.priority).toBeNull();
  });

  it('selects the column for both the history and the spool projections', async () => {
    const seen: string[] = [];
    const pool: any = {
      query: async (sql: string) => {
        seen.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
    const repository = new KamexSqlboxRepository();
    (repository as any).pool = pool;
    await repository.list({ allowedSmscIds: ['carrier-a'] });
    await repository.listQueue({ allowedSmscIds: ['carrier-a'] });
    expect(seen[0]).toContain('m.priority');
    expect(seen[1]).toContain('priority');
  });

  it('is a CSV export column', () => {
    expect(KamexSqlboxRepository.EXPORT_COLUMNS).toContain('priority');
    expect(KamexSqlboxRepository.EXPORT_COLUMNS.at(-1)).toBe('text');
  });
});

/**
 * THE GUARD THAT MATTERS MOST.
 *
 * Everything above is inert without the driver patch: sqlbox's SELECT is a
 * fixed string compiled into a binary, and a column it does not name is
 * invisible to it. If someone removes or breaks the sed block in the sqlbox
 * Dockerfile, `send_sms.priority` silently becomes a field JKANNEL writes and
 * the engine never reads — indistinguishable from working, in production.
 *
 * So the patch is pinned here by content, not by presence of a comment.
 */
describe('the sqlbox PostgreSQL priority patch is present in the image build', () => {
  const dockerfile = readFileSync(
    resolve(__dirname, '../../../infrastructure/kannel/sqlbox/Dockerfile'),
    'utf8',
  );

  it('adds the column to both CREATE TABLE statements', () => {
    expect(dockerfile).toContain(
      's/meta_data TEXT NULL, foreign_id VARCHAR(255) NULL)/meta_data TEXT NULL, priority BIGINT NULL, foreign_id VARCHAR(255) NULL)/g',
    );
  });

  it('adds the column to the SELECT sqlbox polls send_sms with', () => {
    expect(dockerfile).toContain('s/binfo, meta_data FROM %S/binfo, meta_data, priority FROM %S/');
  });

  it('adds the column and one more placeholder to the sent_sms INSERT', () => {
    expect(dockerfile).toContain(
      's/binfo, meta_data, foreign_id) VALUES (%S, %S, %S,/binfo, meta_data, priority, foreign_id) VALUES (%S, %S, %S, %S,/',
    );
  });

  it('reads the column back at index 27 and writes it out again', () => {
    // Mirrors sqlbox_mysql.c:148 `msg->sms.priority = atol_null(row[27])`.
    expect(dockerfile).toContain('msg->sms.priority = atol_null(27)');
    expect(dockerfile).toContain('st_num(msg->sms.priority)');
  });

  it('fails the build when a substitution stops matching', () => {
    // A sed that matches nothing exits 0. Without these assertions the image
    // would build clean and ship an unpatched binary.
    expect(dockerfile).toContain(
      'test "$(grep -c \'priority BIGINT NULL\' gw/sqlbox_pgsql.h)" -eq 2',
    );
    expect(dockerfile).toContain("grep -q 'binfo, meta_data, priority FROM %S' gw/sqlbox_pgsql.h");
    expect(dockerfile).toContain(
      "grep -q 'binfo, meta_data, priority, foreign_id) VALUES' gw/sqlbox_pgsql.h",
    );
    expect(dockerfile).toContain("grep -q 'st_num(msg->sms.priority)' gw/sqlbox_pgsql.c");
    expect(dockerfile).toContain("grep -q 'msg->sms.priority = atol_null(27);' gw/sqlbox_pgsql.c");
    // 1 table name + 27 value placeholders. A mismatch is an octstr_format
    // arity bug that would corrupt every logged row.
    expect(dockerfile).toMatch(/grep -o '%S' \| wc -l\)" -eq 28/);
  });

  it('verifies the patched string survived into the linked binary', () => {
    // The only evidence that the compiler consumed the patched source.
    expect(dockerfile).toContain("grep -qa 'binfo, meta_data, priority FROM' gw/sqlbox");
  });

  it('leaves foreign_id alone, because it carries the sql_id correlation key', () => {
    // sqlbox_pgsql.c stamps the consumed send_sms.sql_id into foreign_id; every
    // trace, resend and derived delivery status depends on it.
    expect(dockerfile).not.toMatch(/sed[^\n]*foreign_id VARCHAR\(255\) NULL\)\/[^\n]*\)"/);
    expect(dockerfile).toContain('foreign_id is deliberately untouched');
  });
});

/**
 * The migration exists for a reason that is easy to get wrong: sqlbox's
 * PostgreSQL CREATE TABLE has no IF NOT EXISTS, so the patched CREATE only ever
 * helps a FRESH database. An existing deployment needs the column added, and it
 * needs it on `sent_sms` too — the patched driver writes priority there on the
 * way past, so a missing column would break history logging, not just ordering.
 */
describe('migration 043 upgrades an existing database', () => {
  const migrations = resolve(__dirname, '../../../database/migrations');
  const up = readFileSync(resolve(migrations, '043_send_sms_priority.up.sql'), 'utf8');
  const down = readFileSync(resolve(migrations, '043_send_sms_priority.down.sql'), 'utf8');

  it('adds the column to send_sms and sent_sms, additively and idempotently', () => {
    expect(up).toContain('ALTER TABLE send_sms ADD COLUMN IF NOT EXISTS priority BIGINT NULL');
    expect(up).toContain('ALTER TABLE sent_sms ADD COLUMN IF NOT EXISTS priority BIGINT NULL');
    expect(up).toContain('BEGIN;');
    expect(up).toContain('COMMIT;');
  });

  it('has a matching down that reverses exactly it', () => {
    expect(down).toContain('ALTER TABLE send_sms DROP COLUMN IF EXISTS priority');
    expect(down).toContain('ALTER TABLE sent_sms DROP COLUMN IF EXISTS priority');
    expect(down).toContain('BEGIN;');
    expect(down).toContain('COMMIT;');
  });

  it('says out loud that it is touching an engine-owned table', () => {
    expect(up).toMatch(/ENGINE-OWNED/i);
  });
});
