The console's list grid — pair it with `.grid-toolbar` above and `.pager` below.

```jsx
<DataTable
  columns={[{ key: 'id', label: 'Message', mono: true }, { key: 'status', label: 'Status' }, { key: 'parts', label: 'Parts', align: 'right' }]}
  rows={rows}
  empty="No messages recorded."
/>
```

Put it inside a `Panel`; `.table-wrap` bleeds the rows to the card edge. Status cells hold a `StatusBadge`.
