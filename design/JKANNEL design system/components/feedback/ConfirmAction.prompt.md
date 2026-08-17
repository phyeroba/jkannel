Use for every disruptive gateway action — reconnect, suspend, resume, failover, service restart, test send.

```jsx
<ConfirmAction
  open={open}
  title="Reconnect mtn_ug_trx1"
  verb="Reconnect"
  impact={[['Current state', 'degraded'], ['Sessions affected', '2 of 2'], ['Queued messages', '1,284'], ['Expected impact', 'submissions pause 5-15s']]}
  onClose={close}
  onConfirm={(reason) => run(reason)}
/>
```

Never confirm a disruptive action without stating impact. The reason string goes to the audit trail, so pass it through to whatever records the action. The button self-disables while in flight so the action cannot be fired twice.
