import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface JobActor {
  tenantId: string;
  userId: string;
}
export interface CreateJobInput {
  type: string;
  input?: unknown;
  idempotencyKey?: string;
}

@Injectable()
export class JobsService {
  constructor(private readonly database: DatabaseService) {}

  async create(actor: JobActor, value: CreateJobInput) {
    if (!/^[a-z][a-z0-9_.-]+$/.test(value.type))
      throw new BadRequestException('type must be a lowercase job type identifier');
    if (
      value.idempotencyKey &&
      (value.idempotencyKey.length < 8 || value.idempotencyKey.length > 128)
    )
      throw new BadRequestException('Idempotency-Key must be between 8 and 128 characters');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      if (value.idempotencyKey) {
        const existing = (
          await client.query('SELECT * FROM api_jobs WHERE type=$1 AND idempotency_key=$2', [
            value.type,
            value.idempotencyKey,
          ])
        ).rows[0];
        if (existing) return { ...existing, replayed: true };
      }
      return (
        await client.query(
          'INSERT INTO api_jobs(tenant_id,type,input,requested_by,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [
            actor.tenantId,
            value.type,
            JSON.stringify(value.input ?? {}),
            actor.userId,
            value.idempotencyKey ?? null,
          ],
        )
      ).rows[0];
    });
  }

  list(actor: JobActor, status?: string, type?: string) {
    return this.database.tenantTransaction(
      actor.tenantId,
      async (client) =>
        (
          await client.query(
            'SELECT * FROM api_jobs WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR type=$2) ORDER BY created_at DESC LIMIT 200',
            [status ?? null, type ?? null],
          )
        ).rows,
    );
  }

  async get(actor: JobActor, id: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (await client.query('SELECT * FROM api_jobs WHERE id=$1', [id])).rows[0];
      if (!row) throw new NotFoundException('Job not found');
      return row;
    });
  }

  async cancel(actor: JobActor, id: string, reason?: string) {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const row = (
        await client.query(
          "UPDATE api_jobs SET status='cancelled',progress=100,error=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING *",
          [id, reason ?? 'Cancelled by operator'],
        )
      ).rows[0];
      if (!row) throw new NotFoundException('Cancellable job not found');
      return row;
    });
  }
}
