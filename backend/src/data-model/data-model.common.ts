import { PoolClient } from 'pg';

/** The authenticated caller (or a system job actor): tenant + user id. */
export interface Actor {
  tenantId: string;
  userId: string;
}

/** Appends an audit_log row inside the current tenant transaction. */
export function audit(
  client: PoolClient,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  newValue: unknown,
  reason?: string,
): Promise<unknown> {
  return client.query(
    'INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor.tenantId,
      actor.userId,
      action,
      entityType,
      entityId,
      newValue ? JSON.stringify(newValue) : null,
      reason ?? null,
    ],
  );
}
