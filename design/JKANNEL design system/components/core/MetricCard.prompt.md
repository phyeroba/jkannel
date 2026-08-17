Metric tile for the four-up dashboard strip.

```jsx
<section className="metrics-grid">
  <MetricCard label="Queue depth" value="0" detail="Messages waiting in SQLBox" icon="queue" tone="good" />
</section>
```

Never fake a figure: when a source is not observable the console shows `unavailable` with tone `warn`, and `…` while checking.
