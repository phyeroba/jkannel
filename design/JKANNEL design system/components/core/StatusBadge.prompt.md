Status pill + dot, with the tone derived from the state word so every screen agrees.

```jsx
<StatusBadge status="healthy" />
<StatusBadge status="degraded" />
<StatusDot status="offline" />
```

good = healthy/available/connected/active · warn = checking/unknown/degraded/pending · bad = failed/offline/critical · info = delivered/distributed. Labels stay lowercase in source and are capitalized by CSS.
