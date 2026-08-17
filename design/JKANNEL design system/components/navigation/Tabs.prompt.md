Tab strip for splitting a dense workspace into one concern at a time. It reuses the shipped `.range-select` / `.range-button` segmented control, so it matches the range pickers on Analytics.

```jsx
<Tabs
  tabs={[{ id: 'policies', label: 'Escalation policies', count: 3 }, { id: 'windows', label: 'Maintenance windows', count: 3 }]}
  value={tab}
  onChange={setTab}
/>
```

Put it in a `Panel`'s `action` slot, or above the panels as a page-level switch. Active tab is a white raised pill with brand text.
