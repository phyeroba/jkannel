# 7. Reports and exports

Getting numbers out of JKANNEL: on screen, as a CSV or PDF, or delivered on a schedule.

---

## The analytics screen

Go to **Analytics & Reports** (Insights group). It is one scrolling page, not tabs.
Top-right controls: **Refresh analytics**, **Generate now** (needs `system.manage`), and
a **Last refreshed** timestamp.

| Section | What it shows |
|---|---|
| **Key metrics** | KPI cards from the analytics API. Each card's detail line reads *"Latest daily period {date}"* or *"Report snapshot"*. |
| **Traffic trend** | Messages and delivery receipts over time, with range buttons **7d**, **14d**, **30d**, **90d**. |
| **Delivery confirmation** | Confirmed vs unconfirmed messages, with a total line. |
| **Traffic by SMSC** / **Traffic by route** | Bar charts plus tables of **Messages** and **DLRs**. |
| **SMSC success rate** / **Route performance** | Tables with **Messages**, **DLRs**, **Success**, **Failure**. |
| **Hourly traffic heatmap** | Volume by day of week and hour, with a peak-hour figure. |
| **Delivery latency (SLA)** | Submit-to-DLR percentiles: **Median (p50)**, **p95**, **p99**, with a sample count. |
| **Report catalog** | The report categories this platform registers, each kind badged **available** or **planned**. |
| **Volume report snapshots** | Scheduled daily/weekly snapshots. |
| **Saved report definitions** | Recurring reports you have defined. |

### Success rate means what you think it means

Success rate is computed from real DLR outcomes:

```
successRate = delivered / (delivered + failed + rejected)
```

Messages still in flight are excluded from the denominator, and when nothing has
finalised the answer is `null` — deliberately, rather than a misleading `0%`.

The older "how many messages have any DLR at all" figure still exists but is labelled
honestly as **DLR coverage**. Do not confuse the two.

---

## Volume snapshots

Scheduled daily and weekly snapshots per tenant — total, per SMSC and per route
(attributed via the target SMSC). Idempotent: re-running a period that already exists is
refused rather than duplicated.

The **Volume report snapshots** table: **Period**, **Type**, **Scope**, **Messages**,
**DLRs**, **Generated**. Click a row for the full breakdown (**Snapshot** plus
**Related breakdown**).

- **Export CSV** / **Export PDF** on the panel header.
- **Generate now** at the top of the page runs the snapshot job immediately. You get
  *"Volume report generation started. Refreshing analytics…"*.

If the table is empty, the message tells you why: *"No volume snapshots have been
generated yet. They appear after the scheduled reporting job runs."* Either wait for
the schedule (`REPORT_JOBS_INTERVAL_MS`, default 15 minutes) or click **Generate now**.

Snapshot generation also notifies report subscribers — holders of `reports.view` or
`system.manage` get an in-app notification.

---

## Saved report definitions — recurring reports

1. In the **Saved report definitions** panel, click **New definition**.
2. Fill in:

   | Field | Options |
   |---|---|
   | **Name** | e.g. `Daily volume CSV`. |
   | **Report type** | Every catalog kind flagged available, shown as `{Category} · {Kind}`. |
   | **Schedule** | **Manual (no schedule)** · **Hourly** · **Daily** · **Weekly** |
   | **Format** | **Summary** · **CSV** |
   | **Enabled** | Ticked by default. |

3. Click **Create definition**.

The grid shows **Name**, **Report type**, **Schedule**, **Format**, **Enabled**,
**Actions**. Per row: **Runs** (opens a run history with **Status**, **Rows**,
**Started**, **Completed**, **Detail**), **Enable**/**Disable**, and **Delete**.

Scheduled reports are delivered to your configured notification channels. If you have
none, they generate but go nowhere — see
[guide 6](06-monitoring-and-alerts.md#make-sure-an-alert-reaches-a-human).

**Monthly and yearly periods are not available.** A database constraint permits only
the period types listed above.

---

## Exporting from any grid

Almost every grid in the console has **Export CSV** and **Export PDF** buttons. Exports
are rendered server-side, bounded in row count, and **audit-logged** — the record
captures who exported, with which filters.

| Grid | Export |
|---|---|
| Messages | CSV / PDF, up to 500 rows per call, all filters honoured |
| SMSC Connections | CSV / PDF |
| Routing | CSV / PDF |
| Alerts | CSV / PDF |
| Users | CSV / PDF |
| Sessions | CSV / PDF |
| Logs & Audit | CSV / PDF, up to 1000 rows |
| Notifications | CSV / PDF |
| Backup & Restore | CSV / PDF |
| API Gateway clients | CSV / PDF |
| Configuration | CSV / PDF |
| Volume snapshots | CSV / PDF, up to 500 rows |
| Queues | CSV (client-side, the loaded rows only) |
| Delivery Reports | CSV, up to 5000 rows |

> **Message exports now match the grid.** CSV, PDF and the on-screen list run the same
> filter parser, so a delivery-status or date filter is honoured everywhere.

> **But a message export returns at most 500 rows per call**, regardless of
> `SQLBOX_EXPORT_MAX_ROWS`. Truncation is signalled only by an `x-jkannel-next-cursor`
> response header and nothing pages automatically. For a bigger extract, page through
> the API with that cursor. Exports are buffered, not streamed.

---

## Delivery reports as a grid

**Delivery Reports** (Messaging group) shows receipts on their own: **Message ID**,
**Recipient**, **Status**, **SMSC**, **Timestamp**. Filter by **SMSC**, page with
**Previous** / **Load more**, and **Export CSV**.

If the store is unreachable it says so: *"Delivery report data is unavailable; the
SQLBox message store could not be reached."* — rather than showing an empty table.

---

## Not available

- **No billing, rating or cost model.** Customer, vendor and financial report kinds are
  flagged `planned` and have no data behind them. Pricing is flat: no per-customer
  tariff, no destination-based rating, and a multi-part message counts as one.
- **7 of 14 SMSC operational report items are missing** — bind time, reconnect count,
  average/max TPS, window utilisation and availability among them.
- **No monthly or yearly report periods.**
- **No large-result streaming.**
- **No executive dashboard beyond the analytics page.** One dashboard exists of the
  eight the specification names.

---

Next: [Customers, quotas, credit and sender IDs →](08-customers-and-quotas.md)
