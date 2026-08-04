import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards migration 036's seed against the codebase drifting away from it.
 *
 * The failure this prevents is specific and has happened before: a controller
 * gains `@RequirePermissions('something.new')`, no catalogue row exists for it,
 * and because no role can be granted a permission that does not exist, the route
 * becomes unreachable for every account except one that was hand-seeded. The
 * audit found `messages.send` in exactly that state.
 *
 * So this re-derives the enforced vocabulary from the source tree on every run
 * rather than trusting a list, and asserts the seed covers it.
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const SOURCE_ROOT = resolve(__dirname, '..');
const MIGRATION = resolve(REPO_ROOT, 'database/migrations/036_rbac.up.sql');
const MIGRATION_DOWN = resolve(REPO_ROOT, 'database/migrations/036_rbac.down.sql');

const SPEC_ROLE_NAMES = [
  'Super Administrator',
  'Administrator',
  'Network Engineer',
  'Operations Engineer',
  'Support Engineer',
  'Read Only',
  'Auditor',
  'API Client',
];

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    // Test files are excluded: openapi-generator.spec.ts declares fixture
    // controllers with `widgets.view`/`widgets.manage`, which are not real
    // product permissions and must not be seeded.
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/** Every string literal passed to `@RequirePermissions(...)` in non-test source. */
function enforcedPermissionCodes(): string[] {
  const codes = new Set<string>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/@RequirePermissions\(([^)]*)\)/g)) {
      for (const literal of match[1].matchAll(/['"]([^'"]+)['"]/g)) codes.add(literal[1]);
    }
  }
  return [...codes].sort();
}

const migration = readFileSync(MIGRATION, 'utf8');

/** Codes in the `INSERT INTO permissions … VALUES` block of migration 036. */
function seededPermissionCodes(): string[] {
  const block = migration.slice(
    migration.indexOf('INSERT INTO permissions'),
    migration.indexOf('ON CONFLICT (code)'),
  );
  return [...block.matchAll(/\('([a-z][a-z0-9_.]*)',/g)].map((match) => match[1]).sort();
}

/** `(role name, permission code)` pairs in the role_permissions seed. */
function seededGrants(): Array<[string, string]> {
  const block = migration.slice(migration.indexOf('INSERT INTO role_permissions'));
  return [...block.matchAll(/\('([^']+)',\s*'([a-z][a-z0-9_.]*)'\)/g)].map((match) => [
    match[1],
    match[2],
  ]);
}

describe('RBAC permission catalogue (migration 036)', () => {
  const enforced = enforcedPermissionCodes();
  const seeded = seededPermissionCodes();

  it('finds the enforced vocabulary in the source tree', () => {
    // Sanity check on the grep itself: if this ever returns nothing the
    // completeness assertion below would pass vacuously.
    expect(enforced.length).toBeGreaterThan(15);
    expect(enforced).toContain('users.manage');
  });

  it('seeds a catalogue row for every @RequirePermissions code in the codebase', () => {
    const missing = enforced.filter((code) => !seeded.includes(code));
    expect(missing).toEqual([]);
  });

  it('seeds messages.send, the code the audit found enforced but uncatalogued', () => {
    expect(seeded).toContain('messages.send');
  });

  it('does not seed API-key gateway scopes into the human role vocabulary', () => {
    // gateway-scopes.ts is explicit that these must stay separate, so that an
    // API key can never inherit an operator's console rights.
    for (const scope of ['sms.send', 'sms.read', 'routing.read', 'audit.read'])
      expect(seeded).not.toContain(scope);
  });

  it('does not seed the openapi test fixture permissions', () => {
    expect(seeded).not.toContain('widgets.view');
    expect(seeded).not.toContain('widgets.manage');
  });

  it('gives every catalogue row a description and a category', () => {
    const rows = [
      ...migration
        .slice(
          migration.indexOf('INSERT INTO permissions'),
          migration.indexOf('ON CONFLICT (code)'),
        )
        .matchAll(/\('([a-z][a-z0-9_.]*)',\s*'([^']+)',\s*'([A-Za-z ]+)'\)/g),
    ];
    expect(rows).toHaveLength(seeded.length);
    for (const [, , description, category] of rows) {
      expect(description.trim().length).toBeGreaterThan(10);
      expect(category.trim().length).toBeGreaterThan(2);
    }
  });
});

describe('RBAC default roles (migration 036)', () => {
  const grants = seededGrants();

  it('seeds the eight roles the specification names', () => {
    for (const name of SPEC_ROLE_NAMES) expect(migration).toContain(`('${name}',`);
  });

  it('grants every seeded role at least one permission', () => {
    for (const name of SPEC_ROLE_NAMES)
      expect(grants.filter(([role]) => role === name).length).toBeGreaterThan(0);
  });

  it('never grants a permission that is not in the catalogue', () => {
    const seeded = seededPermissionCodes();
    const invented = grants.filter(([, code]) => !seeded.includes(code));
    expect(invented).toEqual([]);
  });

  it('gives Super Administrator the entire catalogue', () => {
    const superAdmin = grants
      .filter(([role]) => role === 'Super Administrator')
      .map(([, code]) => code)
      .sort();
    expect(superAdmin).toEqual(seededPermissionCodes());
  });

  it('keeps Read Only free of every mutating permission', () => {
    const readOnly = grants.filter(([role]) => role === 'Read Only').map(([, code]) => code);
    for (const code of readOnly) expect(code.endsWith('.view')).toBe(true);
  });

  it('withholds session revocation from Auditor', () => {
    const auditor = grants.filter(([role]) => role === 'Auditor').map(([, code]) => code);
    expect(auditor).toContain('system.view');
    // users.sessions also authorises POST /sessions/:id/revoke.
    expect(auditor).not.toContain('users.sessions');
  });
});

describe('RBAC seeding safety (migration 036)', () => {
  const down = readFileSync(MIGRATION_DOWN, 'utf8');

  it('is idempotent: every seeding INSERT carries an ON CONFLICT clause', () => {
    // Comment lines discuss ON CONFLICT too; count only executable SQL.
    const sql = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const inserts = [...sql.matchAll(/INSERT INTO (\w+)/g)].map((match) => match[1]);
    expect(inserts).toEqual(['permissions', 'roles', 'role_permissions']);
    expect(sql.match(/ON CONFLICT/g)).toHaveLength(inserts.length);
  });

  it('adds columns idempotently so a re-run is a no-op', () => {
    expect(migration.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(3);
  });

  // The live VPS operator account is bound to the lowercase `administrator`
  // role and must keep all 21 of its permissions.
  it('never deletes a permission, a role or a grant', () => {
    expect(migration).not.toMatch(/DELETE FROM/i);
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });

  it('touches the live `administrator` role only to protect it from deletion', () => {
    const statements = migration
      .split('\n')
      .filter((line) => line.includes("'administrator'") && !line.trim().startsWith('--'));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('is_system = true');
    expect(statements[0]).not.toMatch(/DELETE|permission/i);
  });

  it('grants nothing to the live `administrator` role (its name is not in the seed)', () => {
    expect(seededGrants().some(([role]) => role === 'administrator')).toBe(false);
  });

  it('re-asserts ENABLE + policy + FORCE + GRANT on every table it writes', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('tenant_isolation');
    expect(migration).toContain("current_setting(''app.tenant_id''");
    expect(migration).toContain('TO jkannel_app');
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration).toMatch(/^COMMIT;$/m);
  });

  it('unforces RLS only inside the transaction that re-forces it', () => {
    // FORCE applies to the owner, so the seed cannot run under it; leaving the
    // tables unforced afterwards would reopen the owner bypass.
    expect(migration.match(/NO FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration.lastIndexOf('NO FORCE ROW LEVEL SECURITY')).toBeLessThan(
      migration.lastIndexOf('FORCE ROW LEVEL SECURITY'),
    );
  });

  it('has a down migration that removes the seed without touching the catalogue', () => {
    expect(down).toMatch(/^BEGIN;$/m);
    expect(down).toMatch(/^COMMIT;$/m);
    expect(down).toContain('DROP COLUMN IF EXISTS is_system');
    // Deleting a permission cascades into role_permissions and would silently
    // strip the live operator account.
    expect(down).not.toMatch(/DELETE FROM permissions/i);
    expect(down).not.toMatch(/DROP TABLE/i);
    for (const name of SPEC_ROLE_NAMES) expect(down).toContain(`'${name}'`);
  });
});
