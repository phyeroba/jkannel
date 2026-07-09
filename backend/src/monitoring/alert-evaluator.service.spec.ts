import { AlertEvaluatorService } from './alert-evaluator.service';
describe('AlertEvaluatorService', () => {
  const service = new AlertEvaluatorService();
  const rule = {
    id: 'queue',
    metric: 'queue.depth',
    comparison: 'gt' as const,
    threshold: 100,
    durationSeconds: 60,
    severity: 'critical' as const,
    enabled: true,
  };
  it('fires only after a sustained threshold', () => {
    const now = new Date(60000);
    expect(
      service.evaluate(
        rule,
        [
          { metric: 'queue.depth', value: 120, observedAt: new Date(0), labels: {} },
          { metric: 'queue.depth', value: 130, observedAt: now, labels: {} },
        ],
        now,
      ).state,
    ).toBe('firing');
  });
  it('clears on the latest healthy sample', () => {
    const now = new Date(60000);
    expect(
      service.evaluate(
        rule,
        [{ metric: 'queue.depth', value: 90, observedAt: now, labels: {} }],
        now,
      ).state,
    ).toBe('inactive');
  });
});
