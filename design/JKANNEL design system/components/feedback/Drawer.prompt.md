# Drawer

```jsx
<Drawer
  open={Boolean(session)}
  eyebrow={session.smsc}
  title={session.id}
  subtitle="Bound (transceiver) · MTN Uganda"
  actions={<button className="secondary-button" onClick={compare}>Compare sessions</button>}
  onClose={() => setOpenId(null)}
>
  …detail sections…
</Drawer>
```

Use it when a register row has more detail than the table can carry but the
operator should not lose their place in the list: the sheet takes 50vw on the
right, the table stays visible behind the scrim, and Esc or a backdrop click
closes it. Below 900px it goes full width.

Body children are laid out as a 22px grid — give each section a `.t-caps`
heading rather than nesting Panels inside the sheet. A `Dialog` opened from a
drawer action stacks above it.

Reach for a dedicated detail route instead when the record has its own tabs,
sub-navigation or a URL operators need to share (Carriers, Services).
