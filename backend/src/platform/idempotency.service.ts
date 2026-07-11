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

  /**
   * How long a record may sit in `processing` before it is presumed abandoned
   * (the handling process crashed or was killed before it could record an
   * outcome) and becomes reclaimable by a retry. Overridable via
   * IDEMPOTENCY_STALE_MS; defaults to 60s, comfortably longer than any normal
   * request but short enough that a stuck key does not block retries for long.
   */
  private staleMs(): number {
    const v = Number(process.env.IDEMPOTENCY_STALE_MS);
    return Number.isFinite(v) && v > 0 ? v : 60_000;
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
      // FOR UPDATE serializes concurrent requests sharing the key so exactly one
      // can reclaim an abandoned/failed record; the loser blocks then sees the
      // fresh 'processing' row and is correctly rejected as concurrent.
      const existing = (
        await client.query<IdempotencyRecord & { updated_at: string }>(
          'SELECT id,request_hash,status,response_status,response_body,updated_at FROM api_idempotency_records WHERE key=$1 AND method=$2 AND route=$3 FOR UPDATE',
          [key, normalizedMethod, route],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new ConflictException(
            'Idempotency-Key was already used with a different request body',
          );
        if (existing.status === 'completed') return { ...existing, replayed: true };
        // A record left 'failed' by an errored handler, or a 'processing' record
        // whose owner never recorded an outcome within the stale window (a crash),
        // is reclaimed so the caller can retry rather than being blocked forever.
        // A genuinely in-flight 'processing' record still returns 409.
        const ageMs = Date.now() - new Date(existing.updated_at).getTime();
        const reclaimable = existing.status === 'failed' || ageMs >= this.staleMs();
        if (!reclaimable)
          throw new ConflictException('Request with this Idempotency-Key is still processing');
        return (
          await client.query<IdempotencyRecord>(
            "UPDATE api_idempotency_records SET status='processing',request_hash=$2,response_status=NULL,response_body=NULL,created_by=$3,created_at=now(),updated_at=now() WHERE id=$1 RETURNING id,request_hash,status,response_status,response_body",
            [existing.id, requestHash, actor.userId],
          )
        ).rows[0];
      }
      return (
        await client.query<IdempotencyRecord>(
          'INSERT INTO api_idempotency_records(tenant_id,key,method,route,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,request_hash,status,response_status,response_body',
          [actor.tenantId, key, normalizedMethod, route, requestHash, actor.userId],
        )
      ).rows[0];
    });
  }

  /**
   * Marks a still-processing record as failed so a subsequent retry with the same
   * Idempotency-Key can proceed immediately (rather than waiting for the stale
   * window). No-op if the record already moved on (e.g. completed).
   */
  fail(actor: IdempotencyActor, id: string): Promise<void> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        "UPDATE api_idempotency_records SET status='failed',updated_at=now() WHERE id=$1 AND status='processing'",
        [id],
      );
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
