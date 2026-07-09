import { ReportingService } from './reporting.service';
describe('ReportingService', () => {
  it('isolates tenants and computes delivery KPIs', () => {
    const result = new ReportingService().deliverySummary('a', [
      {
        tenantId: 'a',
        smscId: 's',
        status: 'delivered',
        submittedAt: new Date(0),
        deliveredAt: new Date(100),
      },
      { tenantId: 'a', smscId: 's', status: 'failed', submittedAt: new Date(0) },
      {
        tenantId: 'b',
        smscId: 's',
        status: 'delivered',
        submittedAt: new Date(0),
        deliveredAt: new Date(1),
      },
    ]);
    expect(result).toMatchObject({
      total: 2,
      delivered: 1,
      failed: 1,
      deliveryRate: 0.5,
      p50LatencyMs: 100,
    });
  });
});
