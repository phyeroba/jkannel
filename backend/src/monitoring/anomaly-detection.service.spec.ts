import { AnomalyDetectionService } from './anomaly-detection.service';

function serviceWith(snapshotRows: any[]) {
  const inserts: any[] = [];
  const client: any = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM report_snapshots')) return { rows: snapshotRows };
      if (sql.includes('INSERT INTO alert_instances')) {
        inserts.push(params);
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    }),
  };
  const database: any = {
    tenantTransaction: jest.fn((_t: string, work: any) => work(client)),
  };
  return { service: new AnomalyDetectionService(database), inserts };
}

function daily(engine: string, label: string, days: Array<[number, number]>) {
  // days newest-first: [messages, dlrs]
  return days.map(([m, d], i) => ({
    scope_key: engine,
    scope_label: label,
    period_start: `2026-07-${String(8 - i).padStart(2, '0')}`,
    message_count: String(m),
    dlr_count: String(d),
  }));
}

describe('AnomalyDetectionService', () => {
  it('opens a critical alert when traffic drops to zero against a healthy baseline', async () => {
    const { service, inserts } = serviceWith(
      daily('carrier-a', 'Carrier A', [
        [0, 0],
        [100, 95],
        [110, 100],
        [90, 88],
        [105, 100],
      ]),
    );
    const findings = await service.runForTenant('1');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'volume_drop', severity: 'critical' });
    expect(inserts[0][1]).toBe('critical');
    expect(inserts[0][2]).toBe('anomaly:volume_drop:carrier-a');
  });

  it('flags a DLR-failure anomaly when few messages get delivery reports', async () => {
    const { service } = serviceWith(
      daily('carrier-b', 'Carrier B', [
        [100, 10],
        [100, 95],
        [100, 96],
        [100, 94],
      ]),
    );
    const findings = await service.runForTenant('1');
    expect(findings[0]).toMatchObject({ kind: 'dlr_failure' });
  });

  it('stays quiet for low-volume or stable SMSCs', async () => {
    const { service } = serviceWith(
      daily('carrier-c', 'Carrier C', [
        [98, 95],
        [100, 96],
        [102, 98],
        [99, 95],
      ]),
    );
    expect(await service.runForTenant('1')).toEqual([]);
  });

  it('needs enough baseline history before deciding', async () => {
    const { service } = serviceWith(
      daily('carrier-d', 'Carrier D', [
        [0, 0],
        [100, 95],
      ]),
    );
    expect(await service.runForTenant('1')).toEqual([]);
  });
});
