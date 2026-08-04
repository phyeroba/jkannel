import { ConflictException, NotFoundException } from '@nestjs/common';
import { AlertLifecycleRepository, AlertStatus, toAlertRecord } from './alert-lifecycle.repository';
import { Actor } from './monitoring-depth.repository';

const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const actor: Actor = { tenantId: '1', userId: 'u1', username: 'ops' };

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * Fake tenant transaction. The client answers the four shapes the repository
 * issues (load-for-update, UPDATE ... RETURNING, comment insert, audit insert)
 * and records every statement so a test can assert what was actually written.
 */
function harness(status: AlertStatus | null = 'open', overrides: Record<string, unknown> = {}) {
  const recorded: Recorded[] = [];
  const row = status
    ? {
        id: ALERT_ID,
        status,
        severity: 'warning',
        summary: 'Bind is connecting',
        assigned_to: null,
        assigned_to_username: null,
        assigned_at: null,
        suppressed_until: null,
        suppressed_reason: null,
        notification_state: 'pending',
        notification_detail: {},
        opened_at: '2026-08-01T00:00:00.000Z',
        resolved_at: null,
        closed_at: null,
        reopen_count: 0,
        escalated_at: null,
        previous_severity: null,
        dedup_count: 1,
        correlation_group: null,
        details: {},
        ...overrides,
      }
    : null;

  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      recorded.push({ sql, params });
      if (sql.includes('FOR UPDATE')) return { rows: row ? [row] : [] };
      if (sql.startsWith('SELECT id FROM alert_instances')) return { rows: row ? [row] : [] };
      if (sql.trim().startsWith('UPDATE alert_instances')) {
        // Reflect the status the statement sets, so assertions test the SQL.
        const set = /SET status='([a-z]+)'/.exec(sql);
        return { rows: [{ ...row, status: set ? set[1] : row?.status }] };
      }
      if (sql.includes('INSERT INTO alert_comments') && sql.includes('RETURNING'))
        return {
          rows: [
            {
              id: 'c1',
              alert_id: ALERT_ID,
              author_id: 'u1',
              author_username: 'ops',
              body: String(params[4] ?? ''),
              kind: 'comment',
              created_at: '2026-08-01T01:00:00.000Z',
            },
          ],
        };
      if (sql.includes('FROM users'))
        return { rows: [{ id: '22222222-2222-4222-8222-222222222222', username: 'alice' }] };
      if (sql.includes('FROM alert_comments'))
        return {
          rows: [
            {
              id: 'c1',
              alert_id: ALERT_ID,
              author_id: 'u1',
              author_username: 'ops',
              body: 'looking',
              kind: 'comment',
              created_at: '2026-08-01T01:00:00.000Z',
            },
          ],
        };
      return { rows: [] };
    }),
  };
  const database: any = {
    tenantTransaction: jest.fn((_tenant: string, work: any) => work(client)),
  };
  return { repository: new AlertLifecycleRepository(database), recorded, database, client };
}

const sqlFor = (recorded: Recorded[], needle: string) =>
  recorded.filter((entry) => entry.sql.includes(needle));

describe('AlertLifecycleRepository transitions', () => {
  it('acknowledges an open alert and records the acknowledgement row', async () => {
    const { repository, recorded } = harness('open');
    const alert = await repository.acknowledge(actor, ALERT_ID, 'on it');
    expect(alert.status).toBe('acknowledged');
    expect(sqlFor(recorded, 'INSERT INTO alert_acknowledgements')).toHaveLength(1);
    expect(sqlFor(recorded, 'INSERT INTO audit_log')[0].params).toContain('alert.acknowledged');
  });

  it('resolves an open alert with a note', async () => {
    const { repository, recorded } = harness('open');
    const alert = await repository.resolve(actor, ALERT_ID, 'carrier restored the link');
    expect(alert.status).toBe('resolved');
    const comment = sqlFor(recorded, 'INSERT INTO alert_comments')[0];
    expect(comment.params).toContain('Resolved: carrier restored the link');
    expect(comment.params).toContain('transition');
  });

  it.each([
    ['resolve', 'resolved'],
    ['resolve', 'closed'],
    ['acknowledge', 'acknowledged'],
    ['acknowledge', 'resolved'],
    ['suppress', 'resolved'],
    ['reopen', 'open'],
    ['close', 'closed'],
    ['assign', 'closed'],
  ] as const)('rejects %s on an alert that is %s with 409', async (action, status) => {
    const { repository } = harness(status);
    const call =
      action === 'assign'
        ? repository.assign(actor, ALERT_ID, 'alice')
        : action === 'suppress'
          ? repository.suppress(actor, ALERT_ID, 30)
          : (repository as any)[action](actor, ALERT_ID);
    await expect(call).rejects.toBeInstanceOf(ConflictException);
  });

  it('raises 404 when the alert does not exist', async () => {
    const { repository } = harness(null);
    await expect(repository.resolve(actor, ALERT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reopens a resolved alert, clears the timestamps and starts a new notification cycle', async () => {
    const { repository, recorded } = harness('resolved');
    const alert = await repository.reopen(actor, ALERT_ID, 'it came back');
    expect(alert.status).toBe('open');
    const update = sqlFor(recorded, 'UPDATE alert_instances')[0].sql;
    expect(update).toContain('resolved_at=NULL');
    expect(update).toContain('reopen_count=reopen_count+1');
    // Without a fresh cycle the escalation chain stays exhausted and the
    // reopened alert would page nobody.
    expect(update).toContain('escalation_cycle=escalation_cycle+1');
    expect(update).toContain("notification_state='pending'");
  });

  it('closes an alert and stamps who closed it', async () => {
    const { repository, recorded } = harness('resolved');
    const alert = await repository.close(actor, ALERT_ID, 'duplicate of INC-2');
    expect(alert.status).toBe('closed');
    expect(sqlFor(recorded, 'UPDATE alert_instances')[0].params).toContain('u1');
  });

  it('every transition writes an audit_log row', async () => {
    for (const [status, run] of [
      ['open', (r: AlertLifecycleRepository) => r.acknowledge(actor, ALERT_ID)],
      ['open', (r: AlertLifecycleRepository) => r.resolve(actor, ALERT_ID)],
      ['open', (r: AlertLifecycleRepository) => r.assign(actor, ALERT_ID, 'alice')],
      ['open', (r: AlertLifecycleRepository) => r.suppress(actor, ALERT_ID, 15)],
      ['resolved', (r: AlertLifecycleRepository) => r.reopen(actor, ALERT_ID)],
      ['resolved', (r: AlertLifecycleRepository) => r.close(actor, ALERT_ID)],
    ] as const) {
      const { repository, recorded } = harness(status);
      await run(repository);
      expect(sqlFor(recorded, 'INSERT INTO audit_log')).toHaveLength(1);
    }
  });

  it('runs every transition inside the actor tenant transaction', async () => {
    const { repository, database } = harness('open');
    await repository.acknowledge(actor, ALERT_ID);
    expect(database.tenantTransaction).toHaveBeenCalledWith('1', expect.any(Function));
  });
});

describe('AlertLifecycleRepository.assign', () => {
  it('resolves the assignee against the tenant users and stores id + username', async () => {
    const { repository, recorded } = harness('open');
    const alert = await repository.assign(actor, ALERT_ID, 'alice');
    const update = sqlFor(recorded, 'UPDATE alert_instances')[0];
    expect(update.params).toContain('22222222-2222-4222-8222-222222222222');
    expect(update.params).toContain('alice');
    expect(alert.id).toBe(ALERT_ID);
  });

  it('rejects an assignee who is not a user in this tenant', async () => {
    const { repository, client } = harness('open');
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FOR UPDATE'))
        return { rows: [{ id: ALERT_ID, status: 'open', dedup_count: 1, reopen_count: 0 }] };
      if (sql.includes('FROM users')) return { rows: [] };
      return { rows: [] };
    });
    await expect(repository.assign(actor, ALERT_ID, 'nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AlertLifecycleRepository.suppress', () => {
  it('sets a suppression window and keeps the alert visible', async () => {
    const { repository, recorded } = harness('open');
    const alert = await repository.suppress(actor, ALERT_ID, 45, 'known carrier maintenance');
    // Status becomes 'suppressed' — which is still <> 'resolved', so the alert
    // stays in the open-alert index and the correlation summary.
    expect(alert.status).toBe('suppressed');
    const update = sqlFor(recorded, 'UPDATE alert_instances')[0];
    expect(update.sql).toContain("suppressed_until=now() + ($2 || ' minutes')::interval");
    expect(update.params).toContain('45');
    expect(update.params).toContain('known carrier maintenance');
  });

  it('rejects a non-positive or absurd window', async () => {
    const { repository } = harness('open');
    await expect(repository.suppress(actor, ALERT_ID, 0)).rejects.toBeInstanceOf(ConflictException);
    await expect(repository.suppress(actor, ALERT_ID, 10_000_000)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('AlertLifecycleRepository comments', () => {
  it('appends an operator comment and returns it', async () => {
    const { repository, recorded } = harness('open');
    const comment = await repository.addComment(actor, ALERT_ID, '  checked the carrier  ');
    expect(comment.body).toBe('checked the carrier');
    expect(comment.kind).toBe('comment');
    expect(sqlFor(recorded, 'INSERT INTO audit_log')[0].params).toContain('alert.commented');
  });

  it('lists the thread oldest-first', async () => {
    const { repository, recorded } = harness('open');
    const comments = await repository.listComments(actor, ALERT_ID);
    expect(comments).toHaveLength(1);
    expect(sqlFor(recorded, 'FROM alert_comments')[0].sql).toContain('ORDER BY created_at ASC');
  });

  it('404s when commenting on an alert that does not exist', async () => {
    const { repository, client } = harness('open');
    client.query.mockImplementation(async () => ({ rows: [] }));
    await expect(repository.addComment(actor, ALERT_ID, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('toAlertRecord', () => {
  it('exposes the contract field names the API promises', () => {
    const record = toAlertRecord({
      id: ALERT_ID,
      status: 'suppressed',
      severity: 'critical',
      summary: 's',
      assigned_to: 'u9',
      assigned_to_username: 'alice',
      assigned_at: '2026-08-01T00:00:00.000Z',
      suppressed_until: '2026-08-01T01:00:00.000Z',
      suppressed_reason: 'noisy',
      notification_state: 'undeliverable',
      notification_detail: { reason: 'no channel' },
      opened_at: '2026-08-01T00:00:00.000Z',
      resolved_at: null,
      closed_at: null,
      reopen_count: '2',
      escalated_at: null,
      previous_severity: 'warning',
      dedup_count: '4',
      correlation_group: 'smsc:carrier-a',
      details: {},
    } as any);
    expect(record.assignedTo).toBe('u9');
    expect(record.suppressedUntil).toBe('2026-08-01T01:00:00.000Z');
    expect(record.notificationState).toBe('undeliverable');
    expect(record.reopenCount).toBe(2);
    expect(record.dedupCount).toBe(4);
  });
});
