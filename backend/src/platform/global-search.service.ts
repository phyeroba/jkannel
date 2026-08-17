import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { normalizeMsisdn } from '../routing-depth/msisdn';

/**
 * One search box over the operational estate (spec §2.1): "Global search for
 * carrier, SMSC, session, message ID and MSISDN where permitted."
 *
 * The console's search filtered navigation labels — useful for finding a screen,
 * no help at all when an operator has a message id from a support ticket or a
 * complaint about one MSISDN and needs the object behind it.
 *
 * WHAT "WHERE PERMITTED" MEANS HERE
 * ---------------------------------------------------------------------------
 * Each result kind is gated on the permission that guards its own screen, and
 * the gate is applied BEFORE the query runs, not by filtering results
 * afterwards. Otherwise the timing of a search tells you whether a matching
 * record exists — which is a disclosure even when the row is never rendered.
 */
export type SearchKind = 'smsc' | 'route' | 'message' | 'msisdn';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  to: string;
}

export interface SearchOutcome {
  query: string;
  hits: SearchHit[];
  /**
   * Kinds NOT searched because the caller lacks the permission. Reported so the
   * console can say "3 results, messages not searched" rather than presenting a
   * partial answer as a complete one.
   */
  skipped: Array<{ kind: SearchKind; permission: string }>;
  /** True when a term looked like an MSISDN and was normalised before matching. */
  interpretedAsMsisdn: boolean;
}

const LIMIT_PER_KIND = 5;

@Injectable()
export class GlobalSearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sqlbox: KamexSqlboxRepository,
  ) {}

  async search(
    actor: { tenantId: string },
    rawQuery: string,
    permissions: ReadonlySet<string>,
  ): Promise<SearchOutcome> {
    const query = rawQuery.trim();
    const hits: SearchHit[] = [];
    const skipped: SearchOutcome['skipped'] = [];
    if (query.length < 2) return { query, hits, skipped, interpretedAsMsisdn: false };

    // A term of mostly digits is treated as a subscriber number, so
    // `+256772000118` and `256772000118` find the same traffic rather than
    // depending on which form the engine happened to store.
    //
    // When normalisation FAILS we still search — by the digits as typed. It
    // fails for a national number like `0772000118` unless DEFAULT_COUNTRY_CODE
    // is configured, because normalizeMsisdn deliberately refuses to invent a
    // country on a multi-country gateway. Refusing to search would punish the
    // operator for that safety property; searching the raw digits does not
    // guess at anything.
    const looksLikeMsisdn = /^[+0-9][0-9\s-]{5,}$/.test(query);
    const normalized = looksLikeMsisdn ? normalizeMsisdn(query) : null;
    const msisdnTerm = looksLikeMsisdn
      ? (normalized?.digits ?? query.replace(/[^0-9]/g, ''))
      : null;

    const may = (permission: string, kind: SearchKind) => {
      if (permissions.has(permission)) return true;
      skipped.push({ kind, permission });
      return false;
    };

    if (may('smsc.view', 'smsc')) hits.push(...(await this.smscs(actor.tenantId, query)));
    if (may('routes.view', 'route')) hits.push(...(await this.routes(actor.tenantId, query)));
    if (may('messages.view', looksLikeMsisdn ? 'msisdn' : 'message'))
      hits.push(...(await this.messages(query, msisdnTerm)));

    return { query, hits, skipped, interpretedAsMsisdn: looksLikeMsisdn };
  }

  private async smscs(tenantId: string, query: string): Promise<SearchHit[]> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const rows = await client.query<{
        id: string;
        engine_id: string;
        name: string;
        type: string;
        lifecycle_state: string;
      }>(
        `SELECT id::text, engine_id, name, type, lifecycle_state
           FROM smsc_definitions
          WHERE deleted_at IS NULL AND (engine_id ILIKE $1 OR name ILIKE $1)
          ORDER BY name LIMIT $2`,
        [`%${query}%`, LIMIT_PER_KIND],
      );
      return rows.rows.map((row) => ({
        kind: 'smsc' as const,
        id: row.engine_id,
        title: row.name || row.engine_id,
        subtitle: `SMSC · ${row.type} · ${row.lifecycle_state}`,
        to: `/smsc?focus=${encodeURIComponent(row.engine_id)}`,
      }));
    });
  }

  private async routes(tenantId: string, query: string): Promise<SearchHit[]> {
    return this.database.tenantTransaction(tenantId, async (client) => {
      const rows = await client.query<{ id: string; name: string; route_type: string }>(
        `SELECT id::text, name, route_type FROM routing_rules
          WHERE name ILIKE $1 ORDER BY name LIMIT $2`,
        [`%${query}%`, LIMIT_PER_KIND],
      );
      return rows.rows.map((row) => ({
        kind: 'route' as const,
        id: row.id,
        title: row.name,
        subtitle: `Route · ${row.route_type}`,
        to: `/routing?focus=${encodeURIComponent(row.id)}`,
      }));
    });
  }

  /**
   * Messages by id or by MSISDN.
   *
   * Reads through the SQLBox repository rather than the database directly,
   * because `send_sms`/`sent_sms` are engine-owned and the repository already
   * carries the availability probe: when SQLBox is not reachable this returns
   * nothing rather than throwing, and the caller reports an incomplete search
   * instead of an error.
   */
  private async messages(query: string, msisdnDigits: string | null): Promise<SearchHit[]> {
    const probe = await this.sqlbox.probe();
    if (!probe.available) return [];
    try {
      const page = await this.sqlbox.list({
        limit: LIMIT_PER_KIND,
        query: msisdnDigits ?? query,
      });
      return (page.items ?? []).map((item: Record<string, unknown>) => ({
        kind: (msisdnDigits ? 'msisdn' : 'message') as SearchKind,
        id: String(item.id ?? ''),
        title: String(item.receiver ?? item.id ?? 'message'),
        subtitle: `Message · ${String(item.deliveryStatus ?? item.status ?? 'unknown')}`,
        to: `/messages?focus=${encodeURIComponent(String(item.id ?? ''))}`,
      }));
    } catch {
      // A search must never be the thing that errors a page.
      return [];
    }
  }
}
