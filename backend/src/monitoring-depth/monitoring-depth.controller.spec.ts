import { BadRequestException } from '@nestjs/common';
import {
  CorrelationController,
  EscalationController,
  MaintenanceController,
} from './monitoring-depth.controller';

const request: any = { principal: { tenantId: '1', userId: 'u1' } };

describe('EscalationController', () => {
  it('validates and forwards escalation steps', () => {
    const repo: any = { createEscalationPolicy: jest.fn(async (a, v) => ({ id: 'p1', ...v })) };
    const controller = new EscalationController(repo);
    void controller.createPolicy(request, {
      name: 'On-call',
      steps: [{ afterMinutes: 5, channelType: 'email', target: 'l1@example.com' }],
    });
    expect(repo.createEscalationPolicy).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      expect.objectContaining({
        name: 'On-call',
        steps: [
          { afterMinutes: 5, channelType: 'email', target: 'l1@example.com', severity: undefined },
        ],
      }),
    );
  });

  it('rejects an empty steps array', () => {
    const controller = new EscalationController({} as any);
    expect(() => controller.createPolicy(request, { name: 'x', steps: [] })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unsupported channel type', () => {
    const controller = new EscalationController({} as any);
    expect(() =>
      controller.createPolicy(request, {
        name: 'x',
        steps: [{ afterMinutes: 1, channelType: 'pigeon', target: 't' }],
      }),
    ).toThrow(BadRequestException);
  });
});

describe('MaintenanceController', () => {
  it('rejects a window whose end is not after its start', () => {
    const controller = new MaintenanceController({} as any);
    expect(() =>
      controller.create(request, {
        name: 'w',
        startsAt: '2026-07-10T06:00:00Z',
        endsAt: '2026-07-10T05:00:00Z',
      }),
    ).toThrow(BadRequestException);
  });

  it('parses scope and forwards a valid window', () => {
    const repo: any = { createMaintenanceWindow: jest.fn(async () => ({ id: 'w1' })) };
    const controller = new MaintenanceController(repo);
    void controller.create(request, {
      name: 'w',
      startsAt: '2026-07-10T05:00:00Z',
      endsAt: '2026-07-10T06:00:00Z',
      scope: { smscs: ['carrier-a'], all: false },
    });
    expect(repo.createMaintenanceWindow).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1' },
      expect.objectContaining({ scope: { all: false, smscs: ['carrier-a'] } }),
    );
  });
});

describe('CorrelationController', () => {
  it('delegates to the repository summary', () => {
    const repo: any = { correlationSummary: jest.fn(() => []) };
    const controller = new CorrelationController(repo);
    controller.list(request);
    expect(repo.correlationSummary).toHaveBeenCalledWith({ tenantId: '1', userId: 'u1' });
  });
});
