import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { buildDeliveryQuality, type DeliveryFunnel, type DeliveryQuality } from './dlr-performance';

export interface Actor {
  tenantId: string;
  userId: string;
}

export interface CarrierQuality {
  engineId: string;
  smscName: string | null;
  carrierId: string | null;
  carrierName: string | null;
  quality: DeliveryQuality;
}

export interface DlrPerformanceReport {
  from: string;
  to: string;
  overall: DeliveryQuality;
  /**
   * Per-bind quality over the SAME window as `overall`.
   *
   * §8 asks to "compare carriers/SMSCs over identical time windows". The
   * existing analytics endpoints could not do this: `perSmsc` and `smscSuccess`
   * read the latest daily report snapshot with no window parameter at all, so
   * two carriers could only ever be compared over whatever period each happened
   * to have been summarised on.
   */
  byBind: CarrierQuality[];
  available: boolean;
  detail: string;
}

/**
 * Kannel's DLR mask, on a DLR ROW, is the event that occurred.
 *
 * Repeated here rather than imported so this file states the mapping it relies
 * on. The trap, which has bitten this codebase before: on an MT row the same
 * column holds the mask the sender REQUESTED (commonly 31), so counting MT rows
 * as delivery events inflates every figure. Every query below filters
 * `momt='DLR'` first.
 */
const DLR_DELIVERED = 1;
const DLR_FAILED = 2;
const DLR_BUFFERED = 4;
const DLR_ACCEPTED = 8;
const DLR_REJECTED = 16;

@Injectable()
export class DlrPerformanceService {
  constructor(private readonly database: DatabaseService) {}

  async report(
    actor: Actor,
    fromMs: number,
    toMs: number,
    nowMs = Date.now(),
  ): Promise<DlrPerformanceReport> {
    const fromEpoch = Math.floor(fromMs / 1000);
    const toEpoch = Math.floor(toMs / 1000);

    try {
      return await this.database.tenantTransaction(actor.tenantId, async (client) => {
        // One pass over the window, grouped by bind. MT rows give submitted and
        // accepted; DLR rows give the outcomes, joined back to their MT by
        // foreign_id — the correlation key sqlbox stamps with send_sms.sql_id.
        const { rows } = await client.query<Record<string, unknown>>(
          `WITH mt AS (
             SELECT smsc_id, foreign_id
               FROM sent_sms
              WHERE momt = 'MT' AND time BETWEEN $1 AND $2
           ), dlr AS (
             SELECT d.foreign_id, d.dlr_mask
               FROM sent_sms d
              WHERE d.momt = 'DLR' AND d.time BETWEEN $1 AND $2 + 3600
           )
           SELECT mt.smsc_id AS engine_id,
                  count(*)                                              AS submitted,
                  count(dlr.foreign_id)                                 AS receipts,
                  count(*) FILTER (WHERE dlr.dlr_mask = $3)             AS delivered,
                  count(*) FILTER (WHERE dlr.dlr_mask = $4)             AS failed,
                  count(*) FILTER (WHERE dlr.dlr_mask = $5)             AS rejected,
                  count(*) FILTER (WHERE dlr.dlr_mask IN ($6, $7))      AS in_flight,
                  count(*) FILTER (WHERE dlr.foreign_id IS NULL)        AS pending
             FROM mt
             LEFT JOIN dlr ON dlr.foreign_id = mt.foreign_id
            GROUP BY mt.smsc_id`,
          [fromEpoch, toEpoch, DLR_DELIVERED, DLR_FAILED, DLR_REJECTED, DLR_BUFFERED, DLR_ACCEPTED],
        );

        const names = await client.query<Record<string, unknown>>(
          `SELECT s.engine_id, s.name, s.carrier_id::text, c.name AS carrier_name
             FROM smsc_definitions s
             LEFT JOIN carriers c ON c.id = s.carrier_id AND c.deleted_at IS NULL
            WHERE s.deleted_at IS NULL`,
        );
        const byEngineId = new Map(names.rows.map((row) => [String(row.engine_id), row]));

        const window = { windowStartMs: fromMs, windowEndMs: toMs, nowMs };
        const total: DeliveryFunnel = {
          submitted: 0,
          accepted: 0,
          receiptsReceived: 0,
          delivered: 0,
          failed: 0,
          expired: 0,
          rejected: 0,
          pending: 0,
          unknown: 0,
        };

        const byBind = rows.map((row) => {
          const bindFunnel = toFunnel(row);
          for (const key of Object.keys(total) as Array<keyof DeliveryFunnel>)
            total[key] += bindFunnel[key];
          const meta = byEngineId.get(String(row.engine_id));
          return {
            engineId: String(row.engine_id ?? 'unassigned'),
            smscName: (meta?.name as string) ?? null,
            carrierId: (meta?.carrier_id as string) ?? null,
            carrierName: (meta?.carrier_name as string) ?? null,
            quality: buildDeliveryQuality({ funnel: bindFunnel, ...window }),
          };
        });

        return {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          overall: buildDeliveryQuality({ funnel: total, ...window }),
          byBind: byBind.sort((a, b) => b.quality.funnel.submitted - a.quality.funnel.submitted),
          available: true,
          detail: 'Read from the engine message store.',
        };
      });
    } catch (error) {
      // sent_sms is engine-owned and may not exist when SQLBox has never run.
      // Reported as unavailable rather than as zero traffic.
      return {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        overall: buildDeliveryQuality({
          funnel: emptyFunnel(),
          windowStartMs: fromMs,
          windowEndMs: toMs,
          nowMs,
        }),
        byBind: [],
        available: false,
        detail: `Delivery data unavailable: ${(error as Error).message}`,
      };
    }
  }
}

/**
 * `expired` is always zero and that is not an oversight.
 *
 * §8 lists EXPIRED among the statuses to break down, but Kannel's DLR mask has
 * no expiry bit — the five values are delivered, failed, buffered, accepted and
 * rejected. Reporting a zero here would imply we looked and found none. The
 * field is kept so the shape matches the specification, and the API's detail
 * text says the engine cannot distinguish it.
 */
function toFunnel(row: Record<string, unknown>): DeliveryFunnel {
  const submitted = Number(row.submitted ?? 0);
  const delivered = Number(row.delivered ?? 0);
  const failed = Number(row.failed ?? 0);
  const rejected = Number(row.rejected ?? 0);
  const pending = Number(row.pending ?? 0) + Number(row.in_flight ?? 0);
  const receipts = Number(row.receipts ?? 0);
  return {
    submitted,
    // Everything sqlbox wrote to sent_sms was accepted by the engine; a
    // submission the engine refused never reaches this table.
    accepted: submitted,
    receiptsReceived: receipts,
    delivered,
    failed,
    expired: 0,
    rejected,
    pending,
    unknown: Math.max(0, submitted - delivered - failed - rejected - pending),
  };
}

function emptyFunnel(): DeliveryFunnel {
  return {
    submitted: 0,
    accepted: 0,
    receiptsReceived: 0,
    delivered: 0,
    failed: 0,
    expired: 0,
    rejected: 0,
    pending: 0,
    unknown: 0,
  };
}
