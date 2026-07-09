import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AI_ASSISTANCE_STORE,
  AssistanceActor,
  AssistanceRecord,
  AssistanceRequest,
  AssistanceStore,
} from './ai-operations.types';
import { redactEvidence, redactText } from './privacy-redactor';
@Injectable()
export class AiOperationsService {
  constructor(@Inject(AI_ASSISTANCE_STORE) private readonly store: AssistanceStore) {}
  async assist(
    actor: AssistanceActor,
    input: AssistanceRequest,
    optIn: boolean,
  ): Promise<AssistanceRecord> {
    if (process.env.AI_OPERATIONS_ENABLED !== 'true')
      throw new BadRequestException('AI Operations is disabled for this deployment');
    if (!optIn)
      throw new BadRequestException(
        'AI Operations is opt-in; explicit consent is required for each request',
      );
    const question = redactText(input.question?.trim() ?? '').slice(0, 1000);
    if (!question) throw new BadRequestException('question is required');
    const evidence = redactEvidence(Array.isArray(input.evidence) ? input.evidence : []);
    const lower =
      `${question} ${evidence.map((x) => `${x.source} ${x.observation}`).join(' ')}`.toLowerCase();
    let observed = 'No normalized operational evidence was supplied.';
    let reasoning = [
      'No external model was called.',
      'The local rules engine cannot infer a cause without normalized evidence.',
    ];
    let recommendation: string | null = null;
    let confidence = 0;
    let risk: 'none' | 'low' | 'medium' | 'high' = 'none';
    let status: AssistanceRecord['status'] = 'insufficient_data';
    if (evidence.length) {
      observed = `${evidence.length} redacted operational observation${evidence.length === 1 ? ' was' : 's were'} evaluated.`;
      confidence = Math.min(85, 45 + evidence.length * 5);
      status = 'advisory';
      reasoning = [
        'Evidence was normalized and evaluated by the local deterministic rules engine.',
      ];
      if (/queue|backlog|congestion/.test(lower)) {
        reasoning.push('Queue growth or congestion indicators were present.');
        recommendation =
          'Review worker throughput, retry rate, and downstream SMSC health before changing capacity.';
        risk = 'medium';
      } else if (/smsc|provider|bind|timeout|disconnect/.test(lower)) {
        reasoning.push('Provider connectivity or SMSC health indicators were present.');
        recommendation =
          'Validate bind health, recent reconnects, latency, and an approved failover route.';
        risk = 'medium';
      } else if (/delivery|dlr|failed|error|retry/.test(lower)) {
        reasoning.push('Delivery failure or retry indicators were present.');
        recommendation =
          'Correlate delivery status, error codes, route selection, and provider health for the same time window.';
        risk = 'low';
      } else {
        reasoning.push('No specialized diagnostic rule matched the supplied evidence.');
        recommendation =
          'Inspect the cited telemetry sources together and collect a comparable healthy time window.';
        risk = 'low';
      }
      if (input.allowRecommendation && recommendation) {
        status = 'approval_required';
        reasoning.push(
          'Any operational follow-up remains blocked until a human records an approval decision.',
        );
      }
    }
    const record: AssistanceRecord = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      requestedBy: actor.userId,
      question,
      evidence,
      observedBehaviour: observed,
      reasoning,
      recommendation,
      confidence,
      risk,
      status,
      model: { provider: 'local-rules', version: 'phase15-v1' },
      createdAt: new Date().toISOString(),
    };
    await this.store.save(actor, record);
    return record;
  }
  async get(actor: AssistanceActor, id: string) {
    const value = await this.store.find(actor, id);
    if (!value) throw new NotFoundException('AI assistance record not found');
    return value;
  }
  async decide(actor: AssistanceActor, id: string, decision: 'approve' | 'reject', reason: string) {
    if (!['approve', 'reject'].includes(decision))
      throw new BadRequestException('decision must be approve or reject');
    if (!reason?.trim()) throw new BadRequestException('reason is required');
    const value = await this.store.approve(
      actor,
      id,
      decision,
      redactText(reason.trim()).slice(0, 500),
    );
    if (!value) throw new NotFoundException('Pending AI assistance record not found');
    return value;
  }
}
