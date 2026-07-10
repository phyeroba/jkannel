import { AuditSignatureService } from './audit-signature.service';

const actor = { tenantId: '1', userId: 'u1' };

function serviceWith(verifyRow: any) {
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('data_model_verify_audit_chain')) return { rows: [verifyRow] };
      return { rows: [] };
    }),
  };
  const db: any = { tenantTransaction: (_t: string, w: any) => w(client) };
  return { service: new AuditSignatureService(db), client };
}

describe('AuditSignatureService.verifyChain', () => {
  it('reports an intact chain', async () => {
    const { service } = serviceWith({
      ok: true,
      checked_rows: '5',
      first_broken_id: null,
      first_broken_uuid: null,
      reason: null,
    });
    const report = await service.verifyChain(actor);
    expect(report).toEqual({
      ok: true,
      checkedRows: 5,
      firstBrokenId: null,
      firstBrokenUuid: null,
      reason: null,
    });
  });

  it('surfaces the first broken row from the SQL verifier', async () => {
    const { service, client } = serviceWith({
      ok: false,
      checked_rows: 3,
      first_broken_id: 42,
      first_broken_uuid: 'uuid-42',
      reason: 'row_hash mismatch',
    });
    const report = await service.verifyChain(actor);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenId).toBe('42');
    expect(report.firstBrokenUuid).toBe('uuid-42');
    expect(report.reason).toBe('row_hash mismatch');
    expect(client.query).toHaveBeenCalledWith('SELECT * FROM data_model_verify_audit_chain($1)', [
      '1',
    ]);
  });
});
