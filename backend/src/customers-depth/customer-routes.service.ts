import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Actor, assertCustomerExists, audit } from './customer-accounts.common';

export interface CustomerRouteRow {
  id: string;
  customer_id: string;
  route_id: string | null;
  smsc_id: string | null;
  priority: number;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BindRouteInput {
  routeId?: string;
  smscId?: string;
  priority?: number;
}

export interface UpdateBindingInput {
  priority?: number;
  enabled?: boolean;
}

const ROUTE_COLUMNS =
  'id,customer_id,route_id,smsc_id,priority,enabled,created_by,created_at,updated_at';

/**
 * Per-customer route bindings (migration 026): the routing rules and/or SMSCs a
 * customer is entitled to use. Each binding references exactly one of a routing
 * rule or an SMSC. The send/routing path can consult these to constrain which
 * routes a customer may dispatch through. Tenant-scoped by row level security;
 * the referenced route/SMSC must belong to the same tenant (enforced by RLS on
 * the referenced tables at lookup time and the foreign keys).
 */
@Injectable()
export class CustomerRoutesService {
  constructor(private readonly database: DatabaseService) {}

  /** Lists the customer's route/SMSC bindings, highest priority first. */
  async list(actor: Actor, customerId: string): Promise<CustomerRouteRow[]> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      return (
        await client.query<CustomerRouteRow>(
          `SELECT ${ROUTE_COLUMNS} FROM customer_routes WHERE customer_id=$1
            ORDER BY priority DESC, created_at`,
          [customerId],
        )
      ).rows;
    });
  }

  /** Binds a routing rule or SMSC to the customer. Exactly one must be given. */
  async bind(actor: Actor, customerId: string, input: BindRouteInput): Promise<CustomerRouteRow> {
    const hasRoute = Boolean(input.routeId);
    const hasSmsc = Boolean(input.smscId);
    if (hasRoute === hasSmsc)
      throw new BadRequestException('exactly one of routeId or smscId is required');
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0)
      throw new BadRequestException('priority must be a non-negative integer');
    return this.database
      .tenantTransaction(actor.tenantId, async (client) => {
        await assertCustomerExists(client, customerId);
        // Verify the referenced resource is visible in this tenant (RLS-scoped)
        // so a bad id fails as a clean 404 rather than a foreign-key error.
        if (hasRoute) {
          const found = (
            await client.query('SELECT 1 FROM routing_rules WHERE id=$1', [input.routeId])
          ).rows[0];
          if (!found) throw new NotFoundException('Routing rule not found');
        } else {
          const found = (
            await client.query('SELECT 1 FROM smsc_definitions WHERE id=$1', [input.smscId])
          ).rows[0];
          if (!found) throw new NotFoundException('SMSC not found');
        }
        const row = (
          await client.query<CustomerRouteRow>(
            `INSERT INTO customer_routes(tenant_id,customer_id,route_id,smsc_id,priority,created_by)
               VALUES($1,$2,$3,$4,$5,$6) RETURNING ${ROUTE_COLUMNS}`,
            [
              actor.tenantId,
              customerId,
              input.routeId ?? null,
              input.smscId ?? null,
              priority,
              actor.userId,
            ],
          )
        ).rows[0];
        await audit(client, actor, 'customer_route.bound', 'customer_route', row.id, null, row);
        return row;
      })
      .catch((error) => {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('That route or SMSC is already bound to this customer');
        throw error;
      });
  }

  /** Updates a binding's priority and/or enabled flag. */
  async update(
    actor: Actor,
    customerId: string,
    bindingId: string,
    input: UpdateBindingInput,
  ): Promise<CustomerRouteRow> {
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0))
      throw new BadRequestException('priority must be a non-negative integer');
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const old = (
        await client.query<CustomerRouteRow>(
          `SELECT ${ROUTE_COLUMNS} FROM customer_routes WHERE id=$1 AND customer_id=$2`,
          [bindingId, customerId],
        )
      ).rows[0];
      if (!old) throw new NotFoundException('Route binding not found');
      const row = (
        await client.query<CustomerRouteRow>(
          `UPDATE customer_routes
              SET priority=COALESCE($3,priority), enabled=COALESCE($4,enabled), updated_at=now()
            WHERE id=$1 AND customer_id=$2 RETURNING ${ROUTE_COLUMNS}`,
          [bindingId, customerId, input.priority ?? null, input.enabled ?? null],
        )
      ).rows[0];
      await audit(client, actor, 'customer_route.updated', 'customer_route', row.id, old, row);
      return row;
    });
  }

  /** Removes a route binding. */
  async remove(actor: Actor, customerId: string, bindingId: string): Promise<void> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      await assertCustomerExists(client, customerId);
      const deleted = (
        await client.query<{ id: string }>(
          'DELETE FROM customer_routes WHERE id=$1 AND customer_id=$2 RETURNING id',
          [bindingId, customerId],
        )
      ).rows[0];
      if (!deleted) throw new NotFoundException('Route binding not found');
      await audit(
        client,
        actor,
        'customer_route.unbound',
        'customer_route',
        deleted.id,
        null,
        null,
      );
    });
  }
}
