import { BadRequestException } from '@nestjs/common';
import { ReportDefinitionsController } from './report-definitions.controller';

const request: any = { principal: { tenantId: '1', userId: 'u1' } };
const uuid = '11111111-1111-4111-8111-111111111111';

describe('ReportDefinitionsController', () => {
  it('validates and forwards a create request', () => {
    const repo: any = { create: jest.fn(async (a, v) => ({ id: uuid, ...v })) };
    const controller = new ReportDefinitionsController(repo);
    void controller.create(request, {
      name: 'Nightly SMSC',
      reportType: 'smsc_success',
      parameters: { days: 7 },
      schedule: 'daily',
      format: 'csv',
    });
    expect(repo.create).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      expect.objectContaining({
        name: 'Nightly SMSC',
        reportType: 'smsc_success',
        parameters: { days: 7 },
        schedule: 'daily',
        format: 'csv',
      }),
    );
  });

  it('rejects a missing name', () => {
    const controller = new ReportDefinitionsController({} as any);
    expect(() => controller.create(request, { reportType: 'smsc_success' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unknown report type', () => {
    const controller = new ReportDefinitionsController({} as any);
    expect(() => controller.create(request, { name: 'x', reportType: 'not_a_report' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unsupported schedule', () => {
    const controller = new ReportDefinitionsController({} as any);
    expect(() =>
      controller.create(request, { name: 'x', reportType: 'latency_sla', schedule: 'monthly' }),
    ).toThrow(BadRequestException);
  });

  it('rejects non-object parameters', () => {
    const controller = new ReportDefinitionsController({} as any);
    expect(() =>
      controller.create(request, { name: 'x', reportType: 'latency_sla', parameters: [1, 2] }),
    ).toThrow(BadRequestException);
  });

  it('distinguishes unschedule (null) from unchanged (omitted) on patch', () => {
    const repo: any = { update: jest.fn(async () => ({ id: uuid })) };
    const controller = new ReportDefinitionsController(repo);

    void controller.update(request, uuid, { schedule: null });
    expect(repo.update).toHaveBeenLastCalledWith(
      { tenantId: '1', userId: 'u1' },
      uuid,
      expect.objectContaining({ schedule: null }),
    );

    void controller.update(request, uuid, { name: 'renamed' });
    expect(repo.update).toHaveBeenLastCalledWith(
      { tenantId: '1', userId: 'u1' },
      uuid,
      expect.objectContaining({ schedule: undefined, name: 'renamed' }),
    );
  });

  it('rejects a non-uuid id', () => {
    const controller = new ReportDefinitionsController({} as any);
    expect(() => controller.get(request, 'not-a-uuid')).toThrow(BadRequestException);
  });
});
