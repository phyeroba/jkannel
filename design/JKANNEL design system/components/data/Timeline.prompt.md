Use wherever an operator has to understand a sequence — a message lifecycle, a session's bind history, an alert from detection to recovery. Preferred over making them infer order from separate tables.

```jsx
<Timeline items={[
  { at: '01:41:07.108', label: 'ingress', detail: 'accepted from submit API', state: 'ok' },
  { at: '01:41:11.002', label: 'submit_sm_resp', detail: 'ESME_RINVDSTADR (0x0000000B)', latency: '118 ms', state: 'error' },
  { at: '—', label: 'DLR', detail: 'no receipt — the carrier never accepted the message', state: 'missing' },
]} />
```

`state: 'missing'` is the important one: it draws a hollow dashed dot so the absent stage reads as evidence rather than as nothing.
