import { NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';

/** The authenticated caller: their tenant and user id. */
export interface Actor {
  tenantId: string;
  userId: string;
}

export interface GridPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Bounds pagination arguments for the list endpoints (1..200, offset >= 0). */
export function pageArgs(query: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
  return { limit, offset };
}

/**
 * Confirms the customer exists within the caller's tenant (row level security
 * scopes the lookup) and throws {@link NotFoundException} otherwise. Every
 * sub-resource service calls this before touching its own tables so a caller
 * never operates against another tenant's — or a non-existent — customer.
 */
export async function assertCustomerExists(client: PoolClient, customerId: string): Promise<void> {
  const found = (await client.query('SELECT 1 FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!found) throw new NotFoundException('Customer not found');
}

/** Appends an audit_log row inside the current tenant transaction. */
export function audit(
  client: PoolClient,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  oldValue: unknown,
  newValue: unknown,
  reason?: string,
): Promise<unknown> {
  return client.query(
    'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      actor.tenantId,
      actor.userId,
      action,
      entityType,
      entityId,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      reason ?? null,
    ],
  );
}
