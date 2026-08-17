The standard console card — use it for every titled block (charts, tables, forms).

```jsx
<Panel title="Message volume" subtitle="Daily total-scope report snapshots" action={<a className="text-link" href="#">View all</a>}>
  …
</Panel>
```

Light theme: white surface, no border, `--shadow`, 10px radius. A table inside uses `.table-wrap` so rows bleed to the card edge.
