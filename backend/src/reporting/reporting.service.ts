import { Injectable } from '@nestjs/common';
export interface DeliveryFact {
  tenantId: string;
  smscId: string;
  status: 'delivered' | 'failed' | 'pending';
  submittedAt: Date;
  deliveredAt?: Date;
}
@Injectable()
export class ReportingService {
  deliverySummary(tenantId: string, facts: ReadonlyArray<DeliveryFact>) {
    const own = facts.filter((f) => f.tenantId === tenantId);
    const delivered = own.filter((f) => f.status === 'delivered');
    const latencies = delivered
      .filter((f) => f.deliveredAt)
      .map((f) => f.deliveredAt!.getTime() - f.submittedAt.getTime())
      .sort((a, b) => a - b);
    return {
      total: own.length,
      delivered: delivered.length,
      failed: own.filter((f) => f.status === 'failed').length,
      pending: own.filter((f) => f.status === 'pending').length,
      deliveryRate: own.length ? delivered.length / own.length : 0,
      p50LatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.5)] : null,
      p95LatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.95)] : null,
    };
  }
}
