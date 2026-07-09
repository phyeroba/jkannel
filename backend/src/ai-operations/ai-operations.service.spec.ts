import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiOperationsService } from './ai-operations.service';
import { AssistanceActor, AssistanceRecord, AssistanceStore } from './ai-operations.types';
class MemoryStore implements AssistanceStore {
  records = new Map<string, AssistanceRecord>();
  async save(_: AssistanceActor, value: AssistanceRecord) {
    this.records.set(`${value.tenantId}:${value.id}`, value);
  }
  async find(actor: AssistanceActor, id: string) {
    return this.records.get(`${actor.tenantId}:${id}`);
  }
  async approve(actor: AssistanceActor, id: string, decision: 'approve' | 'reject') {
    const value = await this.find(actor, id);
    if (!value || value.status !== 'approval_required') return undefined;
    const next = {
      ...value,
      status: (decision === 'approve' ? 'approved' : 'rejected') as AssistanceRecord['status'],
      approvedBy: actor.userId,
    };
    this.records.set(`${actor.tenantId}:${id}`, next);
    return next;
  }
}
describe('AiOperationsService', () => {
  const actor = { tenantId: '1', userId: 'operator' };
  let store: MemoryStore;
  let service: AiOperationsService;
  beforeEach(() => {
    process.env.AI_OPERATIONS_ENABLED = 'true';
    store = new MemoryStore();
    service = new AiOperationsService(store);
  });
  afterAll(() => {
    delete process.env.AI_OPERATIONS_ENABLED;
  });
  it('is disabled at deployment level by default', async () => {
    delete process.env.AI_OPERATIONS_ENABLED;
    await expect(
      service.assist(actor, { question: 'Why?', evidence: [], allowRecommendation: false }, true),
    ).rejects.toThrow('disabled');
  });
  it('requires explicit per-request opt in', async () => {
    await expect(
      service.assist(actor, { question: 'Why?', evidence: [], allowRecommendation: false }, false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('redacts private data and explains the local fallback', async () => {
    const result = await service.assist(
      actor,
      {
        question: 'Queue for +256700123456 has password=hunter2',
        evidence: [
          { source: 'queue', observation: 'token=abcdefghijklmnopqrstuv queue is growing' },
        ],
        allowRecommendation: true,
      },
      true,
    );
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('256700123456');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuv');
    expect(result.model.provider).toBe('local-rules');
    expect(result.reasoning.join(' ')).toContain('human');
    expect(result.status).toBe('approval_required');
  });
  it('returns an explicit insufficient-data result instead of fabricating evidence', async () => {
    const result = await service.assist(
      actor,
      { question: 'Why is traffic slow?', evidence: [], allowRecommendation: true },
      true,
    );
    expect(result.status).toBe('insufficient_data');
    expect(result.confidence).toBe(0);
    expect(result.recommendation).toBeNull();
  });
  it('keeps records tenant scoped and gates decisions', async () => {
    const result = await service.assist(
      actor,
      {
        question: 'Why is the SMSC timing out?',
        evidence: [{ source: 'smsc', observation: 'timeouts increased' }],
        allowRecommendation: true,
      },
      true,
    );
    await expect(service.get({ tenantId: '2', userId: 'other' }, result.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const approved = await service.decide(actor, result.id, 'approve', 'Reviewed evidence');
    expect(approved.status).toBe('approved');
    await expect(service.decide(actor, result.id, 'approve', 'again')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
