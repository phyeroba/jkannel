import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface LoginHistoryActor {
  tenantId: string;
}

export interface LoginHistoryRow {
  id: string;
  user_id: string | null;
  username: string | null;
  outcome: string;
  ip_address: string | null;
  user_agent: string | null;
  mfa_used: boolean;
  created_at: Date;
}

export interface LoginHistoryPage {
  items: LoginHistoryRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Tenant-scoped read access to login_history. Runs inside a tenant transaction
 * so row level security confines results to the caller's tenant (migration 017).
 */
@Injectable()
export class LoginHistoryService {
  constructor(private readonly database: DatabaseService) {}

  async list(
    actor: LoginHistoryActor,
    options: { userId?: string; limit: number; offset: number },
  ): Promise<LoginHistoryPage> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const params: unknown[] = [];
      let where = '';
      if (options.userId) {
        params.push(options.userId);
        where = `WHERE user_id=$${params.length}`;
      }
      params.push(options.limit);
      const limit = `$${params.length}`;
      params.push(options.offset);
      const offset = `$${params.length}`;
      const result = await client.query<LoginHistoryRow & { __total: string }>(
        `SELECT id,user_id,username,outcome,ip_address,user_agent,mfa_used,created_at,count(*) OVER() AS __total FROM login_history ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as LoginHistoryRow);
      return { items, total, limit: options.limit, offset: options.offset };
    });
  }
}
