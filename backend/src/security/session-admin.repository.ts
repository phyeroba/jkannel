import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface SessionActor {
  tenantId: string;
  userId: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  username: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface SessionPage {
  items: SessionRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Tenant-scoped read/administration of auth_sessions. Every query runs inside a
 * tenant transaction so PostgreSQL row level security confines results to the
 * caller's tenant (see migration 011/003); RLS is the isolation boundary, the
 * WHERE clauses below are only for filtering.
 */
@Injectable()
export class SessionAdminRepository {
  constructor(private readonly database: DatabaseService) {}

  async listSessions(
    actor: SessionActor,
    options: {
      userId?: string;
      active?: boolean;
      search?: string;
      sort?: string;
      limit: number;
      offset: number;
    },
  ): Promise<SessionPage> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (options.userId) {
        params.push(options.userId);
        clauses.push(`s.user_id=$${params.length}`);
      }
      if (options.active) clauses.push('s.revoked_at IS NULL AND s.expires_at>now()');
      if (options.search && options.search.trim()) {
        params.push(`%${options.search.trim()}%`);
        const ref = `$${params.length}`;
        clauses.push(
          `(u.username ILIKE ${ref} OR s.ip_address::text ILIKE ${ref} OR s.user_agent ILIKE ${ref})`,
        );
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      // Whitelisted sort mapping; defaults to newest first.
      const sortColumns: Record<string, string> = {
        createdAt: 's.created_at',
        lastSeenAt: 's.last_seen_at',
        expiresAt: 's.expires_at',
        username: 'u.username',
      };
      let orderBy = 's.created_at DESC';
      if (options.sort) {
        const desc = options.sort.startsWith('-');
        const col = sortColumns[options.sort.replace(/^-/, '')];
        if (col) orderBy = `${col} ${desc ? 'DESC' : 'ASC'}`;
      }
      params.push(options.limit);
      const limit = `$${params.length}`;
      params.push(options.offset);
      const offset = `$${params.length}`;
      const result = await client.query<SessionRow & { __total: string }>(
        `SELECT s.id,s.user_id,u.username,s.created_at,s.last_seen_at,s.expires_at,s.revoked_at,s.ip_address,s.user_agent,count(*) OVER() AS __total FROM auth_sessions s JOIN users u ON u.id=s.user_id ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      const total = result.rows.length ? Number(result.rows[0].__total) : 0;
      const items = result.rows.map(({ __total, ...row }) => row as SessionRow);
      return { items, total, limit: options.limit, offset: options.offset };
    });
  }

  async revokeSession(actor: SessionActor, id: string): Promise<{ id: string; revoked_at: Date }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const existing = (
        await client.query<{ id: string; user_id: string }>(
          'SELECT id,user_id FROM auth_sessions WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!existing) throw new NotFoundException('Session not found');
      const row = (
        await client.query<{ id: string; revoked_at: Date }>(
          'UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id,revoked_at',
          [id],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value) VALUES($1,$2,$3,$4,$5,$6)',
        [
          actor.tenantId,
          actor.userId,
          'session.revoked',
          'auth_session',
          id,
          JSON.stringify({ userId: existing.user_id, revokedAt: row.revoked_at }),
        ],
      );
      return row;
    });
  }
}
