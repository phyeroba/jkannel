import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface RevealGrant {
  id: string;
  reason: string;
  scopeMessageRef: string | null;
  grantedAt: string;
  expiresAt: string;
  revealCount: number;
}

/**
 * Default window. Long enough to work one investigation, short enough that an
 * operator who forgets to revoke is not left holding the ability to read every
 * subscriber for the rest of their shift.
 */
const DEFAULT_MINUTES = 15;
const MAX_MINUTES = 60;

/**
 * Time-limited authority to see unmasked subscriber data (spec §10, §18).
 *
 * The permission `messages.reveal` says an operator MAY ask. A grant is the
 * asking: it has a reason, an expiry and a count of how many times it was
 * actually used, so an audit can distinguish "was authorised" from "looked".
 */
@Injectable()
export class PiiRevealService {
  constructor(private readonly database: DatabaseService) {}

  async grant(
    actor: Actor,
    input: { reason: string; minutes?: number; messageRef?: string | null },
  ): Promise<RevealGrant> {
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 3)
      throw new BadRequestException(
        'A reason is required to reveal subscriber data. It is recorded against every row you ' +
          'then read, and is what makes the access defensible afterwards.',
      );
    const minutes = Math.min(Math.max(Math.floor(input.minutes ?? DEFAULT_MINUTES), 1), MAX_MINUTES);

    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO pii_reveal_grants(tenant_id,user_id,reason,scope_message_ref,expires_at)
         VALUES($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)
         RETURNING id::text, reason, scope_message_ref, granted_at, expires_at, reveal_count`,
        [actor.tenantId, actor.userId, reason, input.messageRef ?? null, String(minutes)],
      );
      await client.query(
        `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value,reason)
         VALUES($1,$2,'pii.reveal.granted','pii_reveal_grant',$3,$4,$5)`,
        [
          actor.tenantId,
          actor.userId,
          rows[0].id,
          JSON.stringify({ minutes, messageRef: input.messageRef ?? null }),
          reason,
        ],
      );
      return toGrant(rows[0]);
    });
  }

  /**
   * The caller's live grant, or null.
   *
   * Deliberately does NOT throw when absent: a read without a grant is a
   * perfectly normal masked read, not an error. Throwing would make the masked
   * path feel like a failure and push people towards holding a grant
   * permanently, which is the behaviour this whole mechanism exists to avoid.
   */
  async activeGrant(actor: Actor, messageRef?: string | null): Promise<RevealGrant | null> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id::text, reason, scope_message_ref, granted_at, expires_at, reveal_count
           FROM pii_reveal_grants
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND (scope_message_ref IS NULL OR scope_message_ref = $2)
          ORDER BY expires_at DESC LIMIT 1`,
        [actor.userId, messageRef ?? null],
      );
      return rows[0] ? toGrant(rows[0]) : null;
    });
  }

  /**
   * Records that a grant was actually used, and on how many rows.
   *
   * Separate from the grant itself because authority and use are different
   * facts. An operator who requested a reveal and then did not look is not the
   * same as one who exported four thousand numbers, and after an incident that
   * is the distinction being investigated.
   */
  async recordUse(actor: Actor, grantId: string, rowCount: number, context: string): Promise<void> {
    await this.database.tenantTransaction(actor.tenantId, async (client) => {
      await client.query(
        'UPDATE pii_reveal_grants SET reveal_count = reveal_count + 1 WHERE id = $1::uuid',
        [grantId],
      );
      await client.query(
        `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,new_value)
         VALUES($1,$2,'pii.revealed','pii_reveal_grant',$3,$4)`,
        [actor.tenantId, actor.userId, grantId, JSON.stringify({ rowCount, context })],
      );
    });
  }

  async revoke(actor: Actor, grantId: string): Promise<{ revoked: boolean }> {
    return this.database.tenantTransaction(actor.tenantId, async (client) => {
      const { rowCount } = await client.query(
        'UPDATE pii_reveal_grants SET revoked_at = now() WHERE id = $1::uuid AND user_id = $2 AND revoked_at IS NULL',
        [grantId, actor.userId],
      );
      if (rowCount)
        await client.query(
          `INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id)
           VALUES($1,$2,'pii.reveal.revoked','pii_reveal_grant',$3)`,
          [actor.tenantId, actor.userId, grantId],
        );
      return { revoked: Boolean(rowCount) };
    });
  }

  /**
   * Resolves whether a request may see unmasked data.
   *
   * `permitted` requires BOTH the permission and a live grant. Holding the
   * permission alone is not enough — that is the difference between "may ask"
   * and "is currently authorised", and collapsing the two would make the time
   * limit decorative.
   */
  async resolve(
    actor: Actor,
    permissions: ReadonlySet<string>,
    wantsReveal: boolean,
    messageRef?: string | null,
  ): Promise<{ permitted: boolean; grant: RevealGrant | null; refusal: string | null }> {
    if (!wantsReveal) return { permitted: false, grant: null, refusal: null };
    if (!permissions.has('messages.reveal'))
      throw new ForbiddenException(
        'Revealing subscriber data requires the messages.reveal permission.',
      );
    const grant = await this.activeGrant(actor, messageRef);
    if (!grant)
      return {
        permitted: false,
        grant: null,
        refusal:
          'No active reveal window. Request one with a reason at POST /privacy/reveal; it lasts ' +
          `${DEFAULT_MINUTES} minutes by default and every row you read under it is audited.`,
      };
    return { permitted: true, grant, refusal: null };
  }
}

function toGrant(row: Record<string, unknown>): RevealGrant {
  return {
    id: String(row.id),
    reason: String(row.reason),
    scopeMessageRef: (row.scope_message_ref as string) ?? null,
    grantedAt: String(row.granted_at),
    expiresAt: String(row.expires_at),
    revealCount: Number(row.reveal_count ?? 0),
  };
}
