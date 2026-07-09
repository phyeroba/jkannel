import { Injectable } from '@nestjs/common';

export type MessageDirection = 'MO' | 'MT';
export interface MessageRecord {
  id: string;
  tenantId: string;
  direction: MessageDirection;
  sender: string;
  recipient: string;
  status: string;
  smscId: string;
  createdAt: Date;
  correlationId?: string;
}
export interface MessageFilter {
  direction?: MessageDirection;
  status?: string;
  smscId?: string;
  sender?: string;
  recipient?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}
@Injectable()
export class MessageExplorerService {
  filter(
    tenantId: string,
    records: ReadonlyArray<MessageRecord>,
    filter: MessageFilter,
  ): MessageRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    if (filter.from && filter.to && filter.from > filter.to) throw new Error('Invalid time range');
    return records
      .filter((m) => m.tenantId === tenantId)
      .filter((m) => !filter.direction || m.direction === filter.direction)
      .filter((m) => !filter.status || m.status === filter.status)
      .filter((m) => !filter.smscId || m.smscId === filter.smscId)
      .filter((m) => !filter.sender || m.sender === filter.sender)
      .filter((m) => !filter.recipient || m.recipient === filter.recipient)
      .filter((m) => !filter.from || m.createdAt >= filter.from)
      .filter((m) => !filter.to || m.createdAt <= filter.to)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
  trace(
    message: MessageRecord,
    events: ReadonlyArray<{
      messageId: string;
      type: string;
      occurredAt: Date;
      details: Readonly<Record<string, unknown>>;
    }>,
  ) {
    return events
      .filter((e) => e.messageId === message.id)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((e) => ({ type: e.type, occurredAt: e.occurredAt.toISOString(), details: e.details }));
  }
}
