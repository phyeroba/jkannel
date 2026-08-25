import { ConsoleRepository } from './console.repository';

/**
 * A soft-deleted row must not come back from a register.
 *
 * WHY THIS TEST AND NOT AN INTEGRATION ONE
 * ---------------------------------------------------------------------------
 * The risk with `deleted_at` is not that the column is missing — a migration
 * settles that, and `scripts/schema-conventions.mjs` re-checks it. The risk is
 * that the column exists and NOTHING FILTERS ON IT, which looks finished from
 * every angle except the one that matters: an operator deletes a user, the row
 * is marked, and the user list still shows them.
 *
 * So what is asserted here is the SQL the shared grid reader builds. Every
 * register in the console goes through that one method, so this is the single
 * place the convention is applied and the single place it can be lost.
 *
 * `liveOnly` and `grid` are private; they are reached through the instance
 * rather than re-implemented, because a copy of the rule in the test would pass
 * happily while the real one was deleted.
 */
type Probe = {
  liveOnly(from: string): string;
};

const repository = () => new ConsoleRepository({} as never) as unknown as Probe;

describe('soft delete on the shared grid reader', () => {
  it('excludes deleted rows from a table that has the column', () => {
    expect(repository().liveOnly('FROM users')).toBe('users.deleted_at IS NULL');
    expect(repository().liveOnly('FROM smsc_definitions')).toBe(
      'smsc_definitions.deleted_at IS NULL',
    );
  });

  it('adds nothing for a table that does not have it', () => {
    // An append-only table must not be filtered on a column it lacks: doing so
    // is not a stricter read, it is a query that throws.
    expect(repository().liveOnly('FROM audit_log')).toBe('');
    expect(repository().liveOnly('FROM metric_samples')).toBe('');
    expect(repository().liveOnly('FROM sent_sms')).toBe('');
  });

  it('qualifies with the alias, because a join makes the column ambiguous', () => {
    // `FROM users u JOIN roles r ...` — both carry `deleted_at` after migration
    // 054, so an unqualified predicate is an error rather than a wrong answer.
    expect(repository().liveOnly('FROM users u JOIN user_roles ur ON ur.user_id = u.id')).toBe(
      'u.deleted_at IS NULL',
    );
    expect(repository().liveOnly('FROM roles AS r')).toBe('r.deleted_at IS NULL');
  });

  it('is not fooled by a keyword sitting where an alias would be', () => {
    // `FROM users JOIN ...` has no alias; "join" is not one, and treating it as
    // one produces `join.deleted_at IS NULL`, which is a syntax error at the
    // worst possible time.
    expect(repository().liveOnly('FROM users JOIN user_roles ON user_roles.user_id = users.id')).toBe(
      'users.deleted_at IS NULL',
    );
    expect(repository().liveOnly('FROM users WHERE x')).toBe('users.deleted_at IS NULL');
    expect(repository().liveOnly('FROM users LEFT JOIN roles ON true')).toBe(
      'users.deleted_at IS NULL',
    );
  });

  it('handles a schema-qualified table', () => {
    expect(repository().liveOnly('FROM public.users')).toBe('users.deleted_at IS NULL');
  });

  it('covers every table the migration gave the column', () => {
    // The list in the repository and the list in migration 054 are two copies
    // of one decision. They are checked against each other here so a table
    // added to the schema and forgotten in the reader fails a test rather than
    // silently returning deleted rows for the rest of its life.
    const migrated = [
      'api_gateway_clients',
      'api_keys',
      'backup_schedules',
      'config_templates',
      'customer_quotas',
      'customer_routes',
      'delivery_retry_policies',
      'escalation_policies',
      'maintenance_windows',
      'messaging_blocklist',
      'messaging_content_rules',
      'mo_routing_rules',
      'mo_rule_destinations',
      'notification_channels',
      'plugin_registrations',
      'report_definitions',
      'roles',
      'sender_ids',
      'system_settings',
      'tenants',
      'users',
    ];
    const missing = migrated.filter((table) => repository().liveOnly(`FROM ${table}`) === '');
    expect(missing).toEqual([]);
  });
});
