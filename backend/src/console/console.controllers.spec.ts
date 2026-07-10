import { BadRequestException } from '@nestjs/common';
import {
  ConfigurationsController,
  ReadModelsController,
  SmscController,
  UsersController,
} from './console.controllers';
import { VolumeReportsController } from './notifications.controllers';

const request: any = { principal: { tenantId: '7', userId: 'user-1' } };
const validUuid = '11111111-1111-4111-8111-111111111111';
describe('console domain controllers', () => {
  const repository: any = {
    createSmsc: jest.fn(),
    invite: jest.fn(),
    createConfiguration: jest.fn(),
  };
  beforeEach(() => jest.clearAllMocks());
  it('rejects an invalid SMSC before persistence', () => {
    expect(() =>
      new SmscController(repository).create(request, { name: 'carrier', type: 'smpp', tps: 0 }),
    ).toThrow(BadRequestException);
    expect(repository.createSmsc).not.toHaveBeenCalled();
  });
  it('archives an SMSC via DELETE', async () => {
    const repo: any = {
      archiveSmsc: jest.fn().mockResolvedValue({ id: validUuid, lifecycle_state: 'archived' }),
    };
    await expect(new SmscController(repo).archive(request, validUuid)).resolves.toMatchObject({
      lifecycle_state: 'archived',
    });
    expect(repo.archiveSmsc).toHaveBeenCalledWith({ tenantId: '7', userId: 'user-1' }, validUuid);
  });
  it('rejects a non-uuid SMSC id on DELETE', () => {
    expect(() => new SmscController({} as any).archive(request, 'nope')).toThrow(
      BadRequestException,
    );
  });
  it('returns a valid, generator-ready configuration baseline', () => {
    const baseline = new ConfigurationsController({} as any).baseline();
    expect(baseline.scope).toBe('gateway');
    expect(baseline.content.smsc[0].id).toBe('example-smsc');
    expect(baseline.content.adminSecretRef.startsWith('secret://')).toBe(true);
    expect(Array.isArray(baseline.notes)).toBe(true);
  });
  it('returns a report snapshot with its period breakdown', async () => {
    const repo: any = {
      getReportSnapshotDetail: jest
        .fn()
        .mockResolvedValue({ snapshot: { id: validUuid }, related: [{ id: 'other' }] }),
    };
    await expect(
      new VolumeReportsController(repo).detail(request, validUuid),
    ).resolves.toMatchObject({ snapshot: { id: validUuid }, related: [{ id: 'other' }] });
    expect(repo.getReportSnapshotDetail).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      validUuid,
    );
  });
  it('rejects malformed invitations', () => {
    expect(() =>
      new UsersController(repository).invite(request, { email: 'not-an-email' }),
    ).toThrow(BadRequestException);
  });
  it('requires configuration content', () => {
    expect(() =>
      new ConfigurationsController(repository).create(request, {
        scope: 'gateway',
        reason: 'change',
      }),
    ).toThrow(BadRequestException);
  });
  it('approves configuration versions before deployment', async () => {
    const repo: any = {
      markConfigurationApproved: jest
        .fn()
        .mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'approved' }),
    };
    const controller = new ConfigurationsController(repo);
    await expect(
      controller.approveSelected(request, {
        id: '11111111-1111-4111-8111-111111111111',
        reason: 'reviewed',
      }),
    ).resolves.toMatchObject({ status: 'approved' });
    expect(repo.markConfigurationApproved).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      '11111111-1111-4111-8111-111111111111',
      'reviewed',
    );
  });
  it('does not deploy unapproved configuration versions', async () => {
    const repo: any = {
      getConfiguration: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'draft',
        content: { rendered: 'group = core' },
      }),
      markConfigurationDeployed: jest.fn(),
    };
    const deployment: any = { deploy: jest.fn() };
    const controller = new ConfigurationsController(repo, undefined, deployment);
    await expect(
      controller.deploy(request, '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deployment.deploy).not.toHaveBeenCalled();
    expect(repo.markConfigurationDeployed).not.toHaveBeenCalled();
  });
  it('validates a persisted configuration version and records the result', async () => {
    const repo: any = {
      getConfiguration: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'draft',
        content: { rendered: 'group = core' },
      }),
      markConfigurationValidated: jest
        .fn()
        .mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'validated' }),
    };
    const deployment: any = {
      validateNative: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
    };
    const controller = new ConfigurationsController(repo, undefined, deployment);
    await expect(
      controller.validateVersion(request, '11111111-1111-4111-8111-111111111111', {
        reason: 'preflight',
      }),
    ).resolves.toMatchObject({ status: 'validated' });
    expect(repo.markConfigurationValidated).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      '11111111-1111-4111-8111-111111111111',
      { valid: true, errors: [] },
      'preflight',
    );
  });
  it('states unavailable SQLBox explicitly', async () => {
    const sqlbox: any = {
      probe: jest.fn().mockResolvedValue({ available: false, evidence: 'not configured' }),
    };
    const controller = new ReadModelsController(sqlbox, undefined, repository);
    expect(await controller.messages(request)).toEqual(
      expect.objectContaining({
        items: [],
        source: expect.objectContaining({ status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE' }),
      }),
    );
    expect((await controller.reports(request)).source.code).toBe('SQLBOX_NOT_AVAILABLE');
  });
  it('restricts SQLBox reads to the tenant’s own SMSC identifiers', async () => {
    const sqlbox: any = {
      probe: jest.fn().mockResolvedValue({ available: true }),
      list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const repo: any = {
      listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a', 'carrier-b']),
    };
    const controller = new ReadModelsController(sqlbox, undefined, repo);
    await controller.messages(request, { limit: '10' });
    expect(repo.listTenantSmscEngineIds).toHaveBeenCalledWith({ tenantId: '7', userId: 'user-1' });
    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSmscIds: ['carrier-a', 'carrier-b'] }),
    );
  });
  it('rejects message submission to an SMSC the tenant does not own', async () => {
    const sqlbox: any = { submit: jest.fn() };
    const repo: any = { listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a']) };
    const controller = new ReadModelsController(sqlbox, undefined, repo);
    await expect(
      controller.submit(request, {
        sender: '100',
        receiver: '+256700000000',
        text: 'hello',
        smscId: 'someone-elses-carrier',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.submit).not.toHaveBeenCalled();
  });
  it('streams SQLBox CSV exports and applies retention through explicit operations', async () => {
    const sqlbox: any = {
      probe: jest.fn().mockResolvedValue({ available: true }),
      exportCsv: jest.fn().mockResolvedValue({
        filename: 'messages.csv',
        rowCount: 1,
        nextCursor: 99,
        content: 'id,status\r\n1,sent',
      }),
      applyRetention: jest.fn().mockResolvedValue({ applied: true, deletedRows: 3 }),
    };
    const response: any = {
      headers: {},
      setHeader: jest.fn((k: string, v: string) => {
        response.headers[k] = v;
      }),
      send: jest.fn(),
    };
    const repo: any = { listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a']) };
    const controller = new ReadModelsController(sqlbox, undefined, repo);
    await controller.exportMessages(request, { limit: '25' }, response);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['x-jkannel-export-row-count']).toBe('1');
    expect(response.send).toHaveBeenCalledWith('id,status\r\n1,sent');
    expect(sqlbox.exportCsv).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSmscIds: ['carrier-a'] }),
    );
    await expect(controller.applyRetention({ olderThanDays: 30, dryRun: false })).resolves.toEqual({
      applied: true,
      deletedRows: 3,
    });
    expect(sqlbox.applyRetention).toHaveBeenCalledWith({ olderThanDays: 30, dryRun: false });
  });
});
