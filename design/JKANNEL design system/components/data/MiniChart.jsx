import React from 'react';

/* Dependency-free SVG series chart (ported from MiniChart.vue): dashed grid,
   tabular tick labels, brand/info strokes, legend below. */
/* The chart fills its panel, so the viewBox is measured in real pixels rather
   than fixed units: scaling a fixed viewBox up to a wide panel would magnify the
   tick labels with it. */
export function MiniChart({ series, height = 160, width: fixedWidth, labels = [], showLegend = true }) {
  const hostRef = React.useRef(null);
  const [measured, setMeasured] = React.useState(fixedWidth || 560);
  React.useEffect(() => {
    if (fixedWidth) return;
    const host = hostRef.current;
    if (!host) return;
    const read = () => {
      const w = Math.round(host.clientWidth) - 44;
      if (w > 80) setMeasured(w);
    };
    read();
    window.addEventListener('resize', read);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(read);
      ro.observe(host);
    }
    return () => {
      window.removeEventListener('resize', read);
      if (ro) ro.disconnect();
    };
  }, [fixedWidth]);
  const width = fixedWidth || measured;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const gridLines = 4;
  const colors = ['var(--brand)', 'var(--info)', 'var(--warn)'];
  const x = (i, n) => (n <= 1 ? 0 : (i / (n - 1)) * width);
  const y = (v) => height - (v / max) * height;
  return (
    <figure ref={hostRef} className="mini-chart" style={{ margin: 0, display: 'grid', gap: 8 }}>
      <svg className="mini-chart-svg" viewBox={`-34 -8 ${width + 44} ${height + 30}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
        <g className="mini-chart-grid">
          {Array.from({ length: gridLines + 1 }, (_, i) => {
            const gy = (i / gridLines) * height;
            return <line key={i} x1="0" x2={width} y1={gy} y2={gy} />;
          })}
        </g>
        <g className="mini-chart-grid">
          {Array.from({ length: gridLines + 1 }, (_, i) => (
            <text key={i} className="mini-chart-tick" x="-8" y={(i / gridLines) * height + 3} textAnchor="end" style={{ fill: 'var(--muted)', fontSize: 10 }}>
              {Math.round(max - (i / gridLines) * max)}
            </text>
          ))}
        </g>
        {series.map((s, si) => (
          <g key={s.name}>
            <polyline
              fill="none"
              stroke={colors[si % colors.length]}
              strokeWidth="2"
              strokeLinejoin="round"
              points={s.values.map((v, i) => `${x(i, s.values.length)},${y(v)}`).join(' ')}
            />
          </g>
        ))}
        {labels.map((label, i) => (
          <text key={label + i} className="mini-chart-tick" x={x(i, labels.length)} y={height + 16} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 10 }}>
            {label}
          </text>
        ))}
      </svg>
      {showLegend ? (
        <figcaption className="mini-chart-legend">
          {series.map((s, si) => (
            <span className="mini-chart-legend-item" key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="mini-chart-swatch" style={{ background: colors[si % colors.length] }} />
              {s.name}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* CSS-bar volume chart used on the operations dashboard. */
export function BarChart({ values, titleFor }) {
  const max = Math.max(1, ...values);
  return (
    <div className="chart" aria-label="Daily message volume">
      {values.map((v, i) => (
        <div key={i} style={{ height: `${Math.max(4, Math.round((v / max) * 100))}%` }} title={titleFor ? titleFor(v, i) : String(v)} />
      ))}
    </div>
  );
}
