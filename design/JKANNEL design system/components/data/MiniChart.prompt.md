Charts with no charting dependency — a line chart for analytics, CSS bars for the dashboard volume panel.

```jsx
<MiniChart series={[{ name: 'Submitted', values: [420, 512, 480, 640] }, { name: 'Delivered', values: [400, 498, 470, 610] }]} labels={['Mon','Tue','Wed','Thu']} />
<BarChart values={[34, 55, 43, 72, 61, 88, 76, 100]} />
```

First series is `--brand`, second `--info`. Axis ticks are tabular; grid lines are dashed `--border`.
