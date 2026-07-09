import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { redactText } from '../ai-operations/privacy-redactor';
import { CopilotActor, CopilotToolsService } from './copilot-tools.service';
import { CopilotAnswer, generateAnswer } from './copilot-provider';

export interface CopilotResponse extends CopilotAnswer {
  question: string;
  toolsRun: Array<{ tool: string; ok: boolean; note?: string }>;
  createdAt: string;
}

/**
 * Ops Copilot: answers natural-language operational questions from read-only,
 * permission-scoped tool data. Gated by the AI Operations opt-in (deployment
 * flag + per-request consent header), audit-logged, and unable to execute any
 * change — it only reads and summarizes.
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly tools: CopilotToolsService,
    private readonly database: DatabaseService,
  ) {}

  async ask(actor: CopilotActor, question: string, optIn: boolean): Promise<CopilotResponse> {
    if (process.env.AI_OPERATIONS_ENABLED !== 'true')
      throw new BadRequestException('AI Operations is disabled for this deployment');
    if (!optIn)
      throw new BadRequestException(
        'The Ops Copilot is opt-in; explicit consent is required for each request',
      );
    const cleaned = redactText((question ?? '').trim()).slice(0, 1000);
    if (!cleaned) throw new BadRequestException('question is required');

    const toolNames = this.selectTools(cleaned, actor);
    const results = await this.tools.run(actor, toolNames);
    const answer = await generateAnswer(cleaned, results);

    await this.audit(
      actor,
      cleaned,
      answer,
      results.map((r) => r.tool),
    );

    return {
      ...answer,
      question: cleaned,
      toolsRun: results.map((r) => ({ tool: r.tool, ok: r.ok, note: r.note })),
      createdAt: new Date().toISOString(),
    };
  }

  /** Picks tools by keyword, filtered to what the caller may access. */
  private selectTools(question: string, actor: CopilotActor): string[] {
    const q = question.toLowerCase();
    const wanted = new Set<string>();
    if (/volume|traffic|messages?|sent|report|throughput|per route|per smsc/.test(q))
      wanted.add('traffic_volume');
    if (/queue|backlog|pending|stuck/.test(q)) wanted.add('queue_depth');
    if (/smsc|bind|carrier|connection|provider/.test(q)) wanted.add('smsc_health');
    if (/alert|anomaly|incident|problem|issue|down|degraded/.test(q)) wanted.add('open_alerts');
    if (/engine|kamex|kannel|capabilit|health|status/.test(q)) wanted.add('engine_capabilities');
    if (/who|audit|change|did|deploy|history/.test(q)) wanted.add('recent_audit');
    // Default to a broad operational snapshot when nothing specific matched.
    if (wanted.size === 0) {
      ['smsc_health', 'open_alerts', 'traffic_volume', 'engine_capabilities'].forEach((t) =>
        wanted.add(t),
      );
    }
    const allowed = new Set(this.tools.available(actor).map((t) => t.name));
    return [...wanted].filter((t) => allowed.has(t));
  }

  private async audit(
    actor: CopilotActor,
    question: string,
    answer: CopilotAnswer,
    tools: string[],
  ): Promise<void> {
    await this.database
      .tenantTransaction(actor.tenantId, (client) =>
        client.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, entity_type, entity_id, new_value)
           VALUES ($1, $2, 'ai.copilot.query', 'ai_copilot', NULL, $3)`,
          [
            actor.tenantId,
            actor.userId,
            JSON.stringify({
              provider: answer.provider,
              model: answer.model,
              tools,
              questionLength: question.length,
            }),
          ],
        ),
      )
      .catch((error) =>
        console.error(
          JSON.stringify({ level: 'error', message: 'copilot audit failed', error: String(error) }),
        ),
      );
  }
}
