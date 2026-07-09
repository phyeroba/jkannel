import { redactText } from '../ai-operations/privacy-redactor';
import { CopilotToolResult } from './copilot-tools.service';

export interface CopilotAnswer {
  answer: string;
  provider: 'local' | 'anthropic';
  model: string;
  citations: string[];
}

/**
 * Turns tool results into an operator-facing answer. Default provider is
 * 'local' — a deterministic summary that calls no external service. When
 * AI_PROVIDER=anthropic and ANTHROPIC_API_KEY are set, the redacted question
 * and tool results are sent to the Claude Messages API for a natural-language
 * answer. Tool results are aggregates only, and the question is redacted before
 * it leaves the process.
 */
export async function generateAnswer(
  question: string,
  toolResults: CopilotToolResult[],
): Promise<CopilotAnswer> {
  const citations = toolResults.filter((r) => r.ok).map((r) => r.tool);
  const provider = process.env.AI_PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY;
  if (provider) {
    try {
      return await callAnthropic(question, toolResults, citations);
    } catch (error) {
      // Fall back to the local summary rather than failing the request.
      const local = summarizeLocally(question, toolResults, citations);
      return {
        ...local,
        answer: `${local.answer}\n\n(External model unavailable: ${(error as Error).message})`,
      };
    }
  }
  return summarizeLocally(question, toolResults, citations);
}

function summarizeLocally(
  question: string,
  toolResults: CopilotToolResult[],
  citations: string[],
): CopilotAnswer {
  const lines: string[] = [];
  for (const result of toolResults) {
    if (!result.ok) {
      lines.push(`- ${result.tool}: unavailable (${result.note ?? 'error'}).`);
      continue;
    }
    lines.push(`- ${result.tool}: ${describe(result)}`);
  }
  const body = lines.length
    ? `Based on the data you can access:\n${lines.join('\n')}`
    : 'No tools were run for this question, or you lack permission for the relevant data.';
  return {
    answer: body,
    provider: 'local',
    model: 'local-summary-v1',
    citations,
  };
}

function describe(result: CopilotToolResult): string {
  const data = result.data as Record<string, any>;
  switch (result.tool) {
    case 'traffic_volume': {
      const totals = (data.snapshots ?? []).filter((s: any) => s.scope === 'total');
      const latest = totals[0];
      return latest
        ? `latest ${latest.period_type} total ${latest.message_count} messages / ${latest.dlr_count} DLRs (from ${totals.length} total snapshots).`
        : 'no volume snapshots yet.';
    }
    case 'queue_depth':
      return data.available
        ? `${data.queued} messages queued.`
        : `queue unavailable (${data.reason}).`;
    case 'smsc_health': {
      const list = data.smscs ?? [];
      const unhealthy = list.filter((s: any) =>
        ['disabled', 'degraded', 'archived'].includes(s.lifecycle_state),
      );
      return `${list.length} SMSC(s), ${unhealthy.length} not fully healthy.`;
    }
    case 'open_alerts': {
      const list = data.alerts ?? [];
      const critical = list.filter((a: any) => a.severity === 'critical').length;
      return `${list.length} open alert(s), ${critical} critical.`;
    }
    case 'engine_capabilities':
      return `engine ${data.identity?.family} ${data.identity?.version}, transport ${data.health?.transport}, engine health ${data.health?.engine}.`;
    case 'recent_audit':
      return `${(data.events ?? []).length} recent audit event(s).`;
    default:
      return 'data retrieved.';
  }
}

async function callAnthropic(
  question: string,
  toolResults: CopilotToolResult[],
  citations: string[],
): Promise<CopilotAnswer> {
  const model = process.env.AI_COPILOT_MODEL ?? 'claude-sonnet-5';
  const system =
    'You are the JKANNEL Ops Copilot, assisting an SMS-gateway operator. Answer ONLY from the ' +
    'provided tool data, which is already tenant-scoped and privacy-redacted. Be concise and ' +
    'operational. If the data is insufficient, say so. Never invent metrics. Never output ' +
    'recipient phone numbers or message contents. Recommend actions only as suggestions for a ' +
    'human to review; you cannot execute anything.';
  const content =
    `Operator question (redacted): ${redactText(question)}\n\n` +
    `Tool results (JSON):\n${JSON.stringify(toolResults).slice(0, 12000)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);
  const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const answer = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  return {
    answer: answer || 'The model returned no text.',
    provider: 'anthropic',
    model,
    citations,
  };
}
