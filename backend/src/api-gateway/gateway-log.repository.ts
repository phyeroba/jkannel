import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type GatewayOutcome = 'allowed' | 'rate_limited' | 'ip_blocked' | 'unauthorized' | 'error';

export interface GatewayLogEntry {
  tenantId: string;
  apiKeyId: string | null;
  keyPrefix: string | null;
  route: string;
  method: string;
  statusCode: number;
  outcome: GatewayOutcome;
  ipAddress: string | null;
  correlationId: string | null;
}

export interface GatewayLogRow {
  id: string;
  api_key_id: string | null;
  key_prefix: string | null;
  route: string;
  method: string;
  status_code: number;
  outcome: GatewayOutcome;
  ip_address: string | null;
  correlation_id: string | null;
  created_at: string;
}

const LOG_COLUMNS =
  'id,api_key_id,key_prefix,route,method,status_code,outcome,ip_address,correlation_id,created_at';

/**
 * Persistence for the per-request gateway audit trail (migration 024). Every
 * write runs inside a tenant transaction so PostgreSQL row level security
 * enforces isolation on gateway_request_log.
 */
@Injectable()
export class GatewayLogRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Record one gateway request outcome. Fire-and-forget safe: logs, never throws. */
  async record(entry: GatewayLogEntry): Promise<void> {
    try {
      await this.database.tenantTransaction(entry.tenantId, (client) =>
        client.query(
          `INSERT INTO gateway_request_log
             (tenant_id, api_key_id, key_prefix, route, method, status_code, outcome, ip_address, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            entry.tenantId,
            entry.apiKeyId,
            entry.keyPrefix,
            entry.route,
            entry.method,
            entry.statusCode,
            entry.outcome,
            entry.ipAddress,
            entry.correlationId,
          ],
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'gateway request log write failed',
          route: entry.route,
          error: String((error as Error).message ?? error),
        }),
      );
    }
  }

  async list(
    tenantId: string,
    options: { limit: number; offset: number },
  ): Promise<{ items: GatewayLogRow[]; total: number; limit: number; offset: number }> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<GatewayLogRow & { __total: string }>(
        `SELECT ${LOG_COLUMNS}, count(*) OVER() AS __total
           FROM gateway_request_log
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [options.limit, options.offset],
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as GatewayLogRow);
      return { items, total, limit: options.limit, offset: options.offset };
    });
  }
}
