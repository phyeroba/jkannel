import React from 'react';
import { Panel } from '../../components/core/Panel.jsx';
import { MetricCard } from '../../components/core/MetricCard.jsx';
import { MiniChart } from '../../components/data/MiniChart.jsx';
import { MT_SERIES, DLR_SERIES, CLOCK_LABELS } from './estate.jsx';

/* Section 14 and 18: gateway-side latency and capacity, with the sampling
   interval and telemetry freshness stated so a reading can be trusted. */
const SUBMIT_LATENCY = [64, 71, 68, 82, 88, 104, 96, 112, 108, 94, 86, 82];
const INTERNAL_LATENCY = [8, 9, 8, 11, 12, 14, 13, 15, 14, 12, 11, 10];

export function PerformanceScreen({ range }) {
  return (
    <>
      <section className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <MetricCard label="Submit latency P95" value="112 ms" detail="API accept to engine handoff" icon="chart" />
        <MetricCard label="Internal queue wait" value="15 ms" detail="engine ingress to submit attempt" icon="queue" />
        <MetricCard label="Headroom" value="320/s" detail="850/s capacity, 530/s in use" icon="server" tone="good" />
        <MetricCard label="Sampling" value="10s" detail="scrape interval, last success 4s ago" icon="cog" />
      </section>

      <Panel title="Gateway latency" subtitle={'Submit path and internal wait, last ' + range + ' at 10-second samples'} style={{ marginBottom: 16 }}>
        <div style={{ marginTop: 16 }}>
          <MiniChart
            series={[{ name: 'Submit P95 (ms)', values: SUBMIT_LATENCY }, { name: 'Internal wait (ms)', values: INTERNAL_LATENCY }]}
            labels={CLOCK_LABELS}
            height={180}
          />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 12 }}>
          Gateway-side latency only. Carrier response latency is on DLR Performance — a rise there with a flat
          line here means the carrier slowed down, not the gateway.
        </p>
      </Panel>

      <Panel title="Capacity" subtitle="Throughput against the sum of known carrier ceilings">
        <div style={{ marginTop: 16 }}>
          <MiniChart
            series={[{ name: 'MT submitted', values: MT_SERIES }, { name: 'DLR received', values: DLR_SERIES }]}
            labels={CLOCK_LABELS}
            height={170}
          />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginTop: 12 }}>
          Peak 512/s against 850/s of aggregate carrier capacity — but 250/s of that sits behind a connection
          that is currently throttling, so usable headroom is lower than the total suggests.
        </p>
      </Panel>
    </>
  );
}
