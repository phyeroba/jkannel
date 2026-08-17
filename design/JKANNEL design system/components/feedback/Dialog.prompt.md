Overlays: a modal dialog, and the console's Ctrl-K command palette that fronts every workspace.

```jsx
<Dialog open={open} title="Pause SMSC" onClose={close} footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button variant="danger">Pause</Button></>}>
  <p>Queued messages stay queued while the bind is paused.</p>
</Dialog>

<CommandPalette open={open} onClose={close} items={navItems} onPick={setRoute} />
```

The header carries the console's own close affordance — a `secondary-button` labelled "Close", as every dialog in the real views does; the icon set has no x glyph. Scrim is `rgba(3,10,20,.68)`; the dialog is 14px radius with a deep `0 24px 70px` shadow, top-anchored at 12vh. Esc and backdrop click both close.
