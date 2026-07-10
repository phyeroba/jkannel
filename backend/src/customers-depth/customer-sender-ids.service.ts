import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Actor, assertCustomerExists, audit } from './customer-accounts.common';

export type SenderIdStatus = 'pending' | 'approved' | 'rejected';

export interface SenderIdRow {
  id: string;
  customer_id: string;
  sender_id: string;
  status: SenderIdStatus;
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RequestSenderIdInput {
  senderId: string;
}

export interface ReviewSenderIdInput {
  status: 'approved' | 'rejected';
  reason?: string;
}

const SENDER_ID_COLUMNS =
  'id,customer_id,sender_id,status,reason,reviewed_by,reviewed_at,created_by,created_at,updated_at';

/**
 * Per-customer allowed sender IDs with an approval workflow (migration 026). A
 * sender ID is requested in 'pending' state and then moved to 'approved' or
 * 'rejected' by an operator; only 'approved' sender IDs should be honoured by
 * the send path. All access is tenant-scoped by row level security.
 */
@Injectable()
export class CustomerSenderIdsService {
  constructor(private readonly database: DatabaseService) {}

  /** Lists the customer's sender IDs (optionally filtered by status). */
  async list(actor: Actor, customerId: string, status?: SenderIdStatus): Promise<SenderIdRow[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      return (
        await client.query<SenderIdRow>(
          `SELECT ${SENDER_ID_COLUMNS} FROM sender_ids
            WHERE customer_id=$1 AND ($2::text IS NULL OR status=$2)
            ORDER BY sender_id`,
          [customerId, status ?? null],
        )
      ).rows;
    });
  }

  /** Requests a new sender ID for the customer (starts 'pending'). */
  async request(
    actor: Actor,
    customerId: string,
    input: RequestSenderIdInput,
  ): Promise<SenderIdRow> {
    return this.database
      .tenantTransaction(actor.tenantId, async (client) => {
        await assertCustomerExists(client, customerId);
        const row = (
          await client.query<SenderIdRow>(
            `INSERT INTO sender_ids(tenant_id,customer_id,sender_id,created_by)
               VALUES($1,$2,$3,$4) RETURNING ${SENDER_ID_COLUMNS}`,
            [actor.tenantId, customerId, input.senderId, actor.userId],
          )
        ).rows[0];
        await audit(client, actor, 'sender_id.requested', 'sender_id', row.id, null, row);
        return row;
      })
      .catch((error) => {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('That sender ID is already registered for this customer');
        throw error;
      });
  }

  /**
   * Reviews a pending sender ID, approving or rejecting it. Only a 'pending'
   * sender ID may be reviewed; re-reviewing an already-decided one is rejected
   * so approval state transitions are explicit and auditable.
   */
  async review(
    actor: Actor,
    customerId: string,
    senderIdRowId: string,
    input: ReviewSenderIdInput,
  ): Promise<SenderIdRow> {
    if (input.status !== 'approved' && input.status !== 'rejected')
      throw new BadRequestException('status must be approved or rejected');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const old = (
        await client.query<SenderIdRow>(
          `SELECT ${SENDER_ID_COLUMNS} FROM sender_ids WHERE id=$1 AND customer_id=$2`,
          [senderIdRowId, customerId],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Sender ID not found');
      if (old.status !== 'pending')
        throw new ConflictException(`Sender ID is already ${old.status}`);
      const row = (
        await client.query<SenderIdRow>(
          `UPDATE sender_ids
              SET status=$3, reason=$4, reviewed_by=$5, reviewed_at=now(), updated_at=now()
            WHERE id=$1 AND customer_id=$2 RETURNING ${SENDER_ID_COLUMNS}`,
          [senderIdRowId, customerId, input.status, input.reason ?? null, actor.userId],
        )
      ).rows[0];
      await audit(
        client,
        actor,
        `sender_id.${input.status}`,
        'sender_id',
        row.id,
        old,
        row,
        input.reason,
      );
      return row;
    });
  }

  /** Removes a sender ID registration. */
  async remove(actor: Actor, customerId: string, senderIdRowId: string): Promise<void> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const deleted = (
        await client.query<{ id: string }>(
          'DELETE FROM sender_ids WHERE id=$1 AND customer_id=$2 RETURNING id',
          [senderIdRowId, customerId],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('Sender ID not found');
      await audit(client, actor, 'sender_id.deleted', 'sender_id', deleted.id, null, null);
    });
  }
}
