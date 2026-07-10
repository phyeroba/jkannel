import {
  RETENTION_POLICIES,
  effectiveRetentionDays,
  retentionCutoff,
  selectEligible,
} from './retention.policy';

const NOW = new Date('2026-07-10T00:00:00.000Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

describe('retention.policy', () => {
  describe('policy registry', () => {
    it('marks audit_log copy-only and the mutable logs archive-then-prune', () => {
      const byTable = Object.fromEntries(RETENTION_POLICIES.map((p) => [p.sourceTable, p]));
      expect(byTable['audit_log'].deleteAfterArchive).toBe(false);
      expect(byTable['notification_deliveries'].deleteAfterArchive).toBe(true);
      expect(byTable['gateway_request_log'].deleteAfterArchive).toBe(true);
    });
  });

  describe('effectiveRetentionDays', () => {
    const policy = RETENTION_POLICIES[0];

    it('uses the default when no env override is set', () => {
      expect(effectiveRetentionDays(policy, {})).toBe(policy.retentionDays);
    });

    it('honors a positive integer env override', () => {
      expect(effectiveRetentionDays(policy, { [policy.retentionEnvVar]: '30' })).toBe(30);
    });

    it('ignores a non-positive / non-integer override', () => {
      expect(effectiveRetentionDays(policy, { [policy.retentionEnvVar]: '-5' })).toBe(
        policy.retentionDays,
      );
      expect(effectiveRetentionDays(policy, { [policy.retentionEnvVar]: 'abc' })).toBe(
        policy.retentionDays,
      );
    });
  });

  describe('selectEligible', () => {
    const cutoff = retentionCutoff({ ...RETENTION_POLICIES[0], retentionDays: 90 }, NOW, {});

    it('selects only rows strictly older than the cutoff', () => {
      const rows = [
        { id: 'old', created_at: daysAgo(120) },
        { id: 'edge-new', created_at: daysAgo(10) },
        { id: 'older', created_at: daysAgo(200) },
      ];
      const eligible = selectEligible(rows, cutoff);
      expect(eligible.map((r) => r.id)).toEqual(['old', 'older']);
    });

    it('excludes rows already archived (older than the watermark)', () => {
      const rows = [
        { id: 'archived', created_at: daysAgo(300) },
        { id: 'fresh-archivable', created_at: daysAgo(120) },
      ];
      const watermark = daysAgo(200);
      const eligible = selectEligible(rows, cutoff, watermark);
      expect(eligible.map((r) => r.id)).toEqual(['fresh-archivable']);
    });

    it('returns nothing when all rows are within the retention window', () => {
      const rows = [{ id: 'a', created_at: daysAgo(1) }];
      expect(selectEligible(rows, cutoff)).toEqual([]);
    });
  });
});
