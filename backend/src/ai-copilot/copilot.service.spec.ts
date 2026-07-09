import { BadRequestException } from '@nestjs/common';
import { CopilotService } from './copilot.service';

const database: any = {
  tenantTransaction: jest.fn((_t: string, work: any) =>
    work({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  ),
};

function toolsStub(available: string[], results: Record<string, any> = {}) {
  return {
    available: jest.fn((actor: any) =>
      available.filter((n) => true).map((name) => ({ name, description: name })),
    ),
    run: jest.fn(async (_actor: any, names: string[]) =>
      names.map((name) => ({ tool: name, ok: true, data: results[name] ?? {} })),
    ),
  };
}

const actor = {
  tenantId: '1',
  userId: 'u1',
  permissions: ['monitoring.view', 'alerts.view', 'smsc.view', 'reports.view'],
};

describe('CopilotService', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.AI_OPERATIONS_ENABLED = 'true';
    process.env.AI_PROVIDER = 'local';
    delete process.env.ANTHROPIC_API_KEY;
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env = original;
  });

  it('refuses when AI Operations is disabled', async () => {
    process.env.AI_OPERATIONS_ENABLED = 'false';
    const service = new CopilotService(toolsStub([]) as any, database);
    await expect(service.ask(actor, 'status?', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses without per-request opt-in consent', async () => {
    const service = new CopilotService(toolsStub([]) as any, database);
    await expect(service.ask(actor, 'status?', false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('selects alert + smsc tools for an incident question and answers locally', async () => {
    const tools = toolsStub(
      ['open_alerts', 'smsc_health', 'engine_capabilities', 'traffic_volume'],
      {
        open_alerts: { alerts: [{ severity: 'critical', summary: 'x' }] },
        smsc_health: { smscs: [{ lifecycle_state: 'active' }, { lifecycle_state: 'degraded' }] },
      },
    );
    const service = new CopilotService(tools as any, database);
    const res = await service.ask(
      actor,
      'why is my carrier alert firing and is the smsc down?',
      true,
    );
    expect(res.provider).toBe('local');
    const ran = tools.run.mock.calls[0][1];
    expect(ran).toEqual(expect.arrayContaining(['open_alerts', 'smsc_health']));
    expect(res.answer).toContain('open_alerts');
    expect(res.citations).toEqual(expect.arrayContaining(['open_alerts', 'smsc_health']));
  });

  it('only runs tools the caller is permitted to use', async () => {
    const limited = { tenantId: '1', userId: 'u1', permissions: ['monitoring.view'] };
    const tools = toolsStub(['engine_capabilities'], {});
    const service = new CopilotService(tools as any, database);
    const res = await service.ask(limited, 'general status', true);
    const ran = tools.run.mock.calls[0][1];
    expect(ran).toEqual(['engine_capabilities']);
    expect(res.answer).toBeTruthy();
  });

  it('redacts phone-number-like content from the question', async () => {
    const tools = toolsStub(['engine_capabilities'], {});
    const service = new CopilotService(tools as any, database);
    const res = await service.ask(actor, 'did we deliver to +256700000000 today', true);
    expect(res.question).not.toContain('256700000000');
  });
});
