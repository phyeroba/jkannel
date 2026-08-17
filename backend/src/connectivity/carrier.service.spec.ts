import { BadRequestException, NotFoundException } from '@nestjs/common';
import { carrierHealth, CarrierService } from './carrier.service';

/**
 * §3.3 defines four health values and adds one prohibition that is the whole
 * reason this is a pure, separately-tested function: *"Unknown: telemetry stale
 * or insufficient; never represent unknown as healthy."*
 *
 * The failure mode is quiet. A carrier whose binds have never been observed has
 * zero failures, and any rollup written as "no failures means healthy" reports
 * it green — an operator then reads a carrier that may be entirely down as fine.
 */
describe('carrierHealth', () => {
  const at = (smscCount: number, bindsTotal: number, bindsHealthy: number, bindsUnobserved = 0) =>
    carrierHealth({ smscCount, bindsTotal, bindsHealthy, bindsUnobserved });

  it('is healthy only when every bind is enabled, observed and up', () => {
    expect(at(3, 3, 3, 0)).toBe('healthy');
  });

  it('is unknown when nothing has been observed, NOT healthy', () => {
    // Zero healthy binds here means "we have not looked", not "all down".
    expect(at(2, 2, 0, 2)).toBe('unknown');
  });

  it('is unknown when the carrier has no SMSCs attached at all', () => {
    // A configuration gap, not a health state. Reporting it green would make an
    // empty carrier indistinguishable from a working one.
    expect(at(0, 0, 0, 0)).toBe('unknown');
  });

  it('is critical when every observed bind is down', () => {
    expect(at(2, 2, 0, 0)).toBe('critical');
  });

  it('is degraded when some binds are up and some are not', () => {
    expect(at(3, 3, 2, 0)).toBe('degraded');
  });

  /**
   * The subtle one. Every bind we CAN see is up, but one has never reported.
   * Claiming "healthy" would generalise from a partial observation to the whole
   * carrier, which is exactly what the prohibition is about.
   */
  it('will not claim healthy while any bind remains unobserved', () => {
    expect(at(3, 3, 2, 1)).toBe('degraded');
  });
});

describe('CarrierService.validate', () => {
  const service = new CarrierService({} as never);

  it('accepts a realistic carrier', () => {
    expect(
      service.validate({ name: 'MTN Uganda', countryCode: 'UG', networkCode: '64110' }),
    ).toEqual([]);
  });

  it('requires a name', () => {
    expect(service.validate({ name: '   ' })).toContain('name is required');
  });

  it('rejects a country name where an ISO code belongs', () => {
    // Keeps the column joinable against a country reference later.
    expect(service.validate({ name: 'x', countryCode: 'Uganda' })[0]).toMatch(/ISO 3166/);
  });

  it('rejects a lower-case country code rather than silently upcasing it', () => {
    expect(service.validate({ name: 'x', countryCode: 'ug' })).toHaveLength(1);
  });

  it('treats the network code as digits, so a leading zero survives', () => {
    // MNC 01 is not MNC 1; storing this as an integer would lose that.
    expect(service.validate({ name: 'x', networkCode: '62001' })).toEqual([]);
    expect(service.validate({ name: 'x', networkCode: '6a1' })[0]).toMatch(/4-6 digits/);
  });

  it('applies the engine-configuration safety rules to operator-typed text', () => {
    const errors = service.validate({ name: 'MTN\nUganda' });
    expect(errors.join(' ')).toMatch(/line break/);
  });

  it('rejects an unknown status', () => {
    expect(service.validate({ name: 'x', status: 'wobbly' as never })[0]).toMatch(/status must be/);
  });
});

/** Fake client that records SQL and answers the shapes the service expects. */
function makeService(rows: Array<Record<string, unknown>> = []) {
  const sql: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      sql.push(text);
      if (text.includes('FROM carriers c')) return { rows, rowCount: rows.length };
      if (text.startsWith('UPDATE carriers')) return { rows, rowCount: rows.length };
      if (text.startsWith('UPDATE smsc_definitions')) return { rows: [], rowCount: 2 };
      if (text.startsWith('SELECT 1 FROM carriers')) return { rows: [{}], rowCount: 1 };
      if (text.startsWith('INSERT INTO carriers')) return { rows, rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const database: any = { tenantTransaction: (_t: string, work: any) => work(client) };
  return { service: new CarrierService(database), sql, client };
}

const actor = { tenantId: '1', userId: 'u1' };
const carrierRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'MTN Uganda',
  country_code: 'UG',
  network_code: '64110',
  status: 'active',
  notes: null,
  created_at: 'now',
  updated_at: 'now',
  smsc_count: 3,
  binds_healthy: 3,
  binds_total: 3,
  binds_unobserved: 0,
  queued_messages: 12,
  failed_messages: 1,
  capacity_tps: 90,
  open_alerts: 0,
};

describe('CarrierService aggregation', () => {
  it('rolls SMSC telemetry up into one row per carrier, in a single query', async () => {
    const { service, sql } = makeService([carrierRow]);
    const [summary] = await service.list(actor);
    expect(summary).toMatchObject({
      name: 'MTN Uganda',
      smscCount: 3,
      bindsHealthy: 3,
      health: 'healthy',
      queuedMessages: 12,
      capacityTps: 90,
    });
    // One aggregate query, not one per carrier: the register is polled, and a
    // thirty-carrier estate would otherwise be thirty-one round trips.
    expect(sql.filter((text) => text.includes('FROM carriers c'))).toHaveLength(1);
  });

  it('reports observed throughput as null, not zero, when it was not computed', async () => {
    // "Not in this projection" is not "no traffic".
    const { service } = makeService([carrierRow]);
    const [summary] = await service.list(actor);
    expect(summary.observedTps).toBeNull();
    expect(summary.utilisation).toBeNull();
  });

  it('404s for a carrier that does not exist', async () => {
    const { service } = makeService([]);
    await expect(service.get(actor, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CarrierService.remove', () => {
  /**
   * Deleting an organisational label must never delete traffic-carrying
   * configuration. The SMSCs survive with their carrier cleared, and both
   * halves are one transaction so an SMSC can never point at a carrier the
   * register has already filtered out.
   */
  it('unassigns the SMSCs and soft-deletes the carrier, reporting how many moved', async () => {
    const { service, sql } = makeService([carrierRow]);
    const result = await service.remove(actor, carrierRow.id);
    expect(result.smscsUnassigned).toBe(2);
    expect(sql.some((text) => text.includes('SET carrier_id = NULL'))).toBe(true);
    expect(sql.some((text) => text.includes('SET deleted_at = now()'))).toBe(true);
  });

  it('404s rather than silently succeeding on an unknown carrier', async () => {
    const { service } = makeService([]);
    await expect(service.remove(actor, carrierRow.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CarrierService.assignSmsc', () => {
  it('detaches when the carrier is null, so a mis-filing is correctable', async () => {
    const { service, client } = makeService([carrierRow]);
    (client.query as jest.Mock).mockImplementation(async (text: string) => {
      if (text.startsWith('UPDATE smsc_definitions')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await service.assignSmsc(actor, carrierRow.id, null);
    expect(result.carrierId).toBeNull();
  });

  it('refuses to file an SMSC under a carrier that does not exist', async () => {
    const { service, client } = makeService([]);
    (client.query as jest.Mock).mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await expect(service.assignSmsc(actor, carrierRow.id, carrierRow.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CarrierService.create', () => {
  it('rejects invalid input before touching the database', async () => {
    const { service, client } = makeService([]);
    await expect(service.create(actor, { name: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).not.toHaveBeenCalled();
  });
});
