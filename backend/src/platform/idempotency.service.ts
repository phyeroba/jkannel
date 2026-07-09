import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface IdempotencyActor {
  tenantId: string;
  userId: string;
}
export interface IdempotencyRecord {
  id: string;
  request_hash: string;
  status: 'processing' | 'completed' | 'failed';
  response_status?: number | null;
  response_body?: unknown;
  replayed?: boolean;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  hashRequest(method: string, route: string, body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify({ method: method.toUpperCase(), route, body: body ?? null }))
      .digest('hex');
  }

  async begin(
    actor: IdempotencyActor,
    key: string,
    method: string,
    route: string,
    requestHash: string,
  ): Promise<IdempotencyRecord> {
    const normalizedMethod = method.toUpperCase();
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const existing = (
        await client.query<IdempotencyRecord>(
          'SELECT id,request_hash,status,response_status,response_body FROM api_idempotency_records WHERE key=$1 AND method=$2 AND route=$3',
          [key, normalizedMethod, route],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ConflictException(
            'Idempotency-Key was already used with a different request body',
          );
        if (existing.status === 'completed') return { ...existing, replayed: true };
        throw new ConflictException('Request with this Idempotency-Key is still processing');
      }
      return (
        await client.query<IdempotencyRecord>(
          'INSERT INTO api_idempotency_records(tenant_id,key,method,route,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,request_hash,status,response_status,response_body',
          [actor.tenantId, key, normalizedMethod, route, requestHash, actor.userId],
        )
      ).rows[0];
    });
  }

  complete(
    actor: IdempotencyActor,
    id: string,
    responseBody: unknown,
    responseStatus = 200,
  ): Promise<void> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await this.completeWithClient(client, id, responseBody, responseStatus);
    });
  }

  private async completeWithClient(
    client: PoolClient,
    id: string,
    responseBody: unknown,
    responseStatus: number,
  ): Promise<void> {
    await client.query(
      "UPDATE api_idempotency_records SET status='completed',response_status=$2,response_body=$3,updated_at=now() WHERE id=$1",
      [id, responseStatus, JSON.stringify(responseBody ?? null)],
    );
  }
}
