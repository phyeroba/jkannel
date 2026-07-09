import { Injectable } from '@nestjs/common';
export interface RouteContext {
  messageId: string;
  destination: string;
  sender?: string;
  now: Date;
  healthySmscIds: ReadonlySet<string>;
}
export interface RouteRule {
  id: string;
  priority: number;
  enabled: boolean;
  destinationPrefix?: string;
  sender?: string;
  targetSmscId: string;
  fallbackSmscId?: string;
}
export interface RouteDecision {
  messageId: string;
  ruleId: string;
  smscId: string;
  reason: string;
}
@Injectable()
export class RoutingService {
  evaluate(context: RouteContext, rules: RouteRule[]): RouteDecision {
    const ordered = [...rules]
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const rule of ordered) {
      if (rule.destinationPrefix && !context.destination.startsWith(rule.destinationPrefix))
        continue;
      if (rule.sender && rule.sender !== context.sender) continue;
      if (context.healthySmscIds.has(rule.targetSmscId))
        return {
          messageId: context.messageId,
          ruleId: rule.id,
          smscId: rule.targetSmscId,
          reason: 'primary target healthy',
        };
      if (rule.fallbackSmscId && context.healthySmscIds.has(rule.fallbackSmscId))
        return {
          messageId: context.messageId,
          ruleId: rule.id,
          smscId: rule.fallbackSmscId,
          reason: 'primary unavailable; fallback selected',
        };
    }
    throw new Error('No eligible route');
  }
}
