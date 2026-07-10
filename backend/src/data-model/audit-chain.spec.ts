import { AuditChainRow, buildChain, rowHash, verifyChain } from './audit-chain';

function row(over: Partial<AuditChainRow> = {}): AuditChainRow {
  return {
    tenantId: '1',
    actorId: 'u1',
    action: 'thing.created',
    entityType: 'thing',
    entityId: 't1',
    oldValue: '',
    newValue: '{"a": 1}',
    reason: '',
    createdAt: '2026-07-10T12:00:00.000000Z',
    ...over,
  };
}

describe('audit-chain', () => {
  it('links each row to the previous row_hash (genesis prev is null)', () => {
    const chain = buildChain([row({ action: 'a' }), row({ action: 'b' }), row({ action: 'c' })]);
    expect(chain[0].prevHash).toBeNull();
    expect(chain[1].prevHash).toBe(chain[0].rowHash);
    expect(chain[2].prevHash).toBe(chain[1].rowHash);
  });

  it('verifies an intact chain', () => {
    const chain = buildChain([row({ action: 'a' }), row({ action: 'b' }), row({ action: 'c' })]);
    const result = verifyChain(chain);
    expect(result.ok).toBe(true);
    expect(result.checkedRows).toBe(3);
    expect(result.firstBrokenIndex).toBe(-1);
  });

  it('detects a tampered field (row_hash no longer matches)', () => {
    const chain = buildChain([row({ action: 'a' }), row({ action: 'b' }), row({ action: 'c' })]);
    // Attacker rewrites the middle row's payload but cannot recompute the stored hash.
    chain[1] = { ...chain[1], newValue: '{"a": 999}' };
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenIndex).toBe(1);
    expect(result.reason).toBe('row_hash mismatch');
  });

  it('detects a removed row (prev_hash linkage breaks)', () => {
    const chain = buildChain([row({ action: 'a' }), row({ action: 'b' }), row({ action: 'c' })]);
    // Drop the middle row: row[2].prevHash now points at a hash not present.
    const tampered = [chain[0], chain[2]];
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.firstBrokenIndex).toBe(1);
    expect(result.reason).toBe('prev_hash mismatch');
  });

  it('rowHash is deterministic and prev-sensitive', () => {
    const r = row();
    expect(rowHash(null, r)).toBe(rowHash(null, r));
    expect(rowHash('abc', r)).not.toBe(rowHash('def', r));
  });
});
