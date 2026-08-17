Buttons for console actions — primary for the one committing action per view, secondary for everything else, danger for destructive.

```jsx
<Button icon="sms">Send message</Button>
<Button variant="secondary">Refresh dashboard</Button>
<Button variant="danger">Delete route</Button>
<IconButton icon="bell" label="Notifications" />
```

Primary is filled `--brand` with a soft violet drop shadow; disabled drops to 0.55 opacity. Labels are sentence case.
