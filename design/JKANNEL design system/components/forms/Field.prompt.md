Form controls as the console ships them: 42px inputs on `--input` with a `--input-border` hairline, 8px radius, 13px medium label above.

```jsx
<TextInput label="Email or Username" autoComplete="username" required />
<PasswordInput minLength={12} />
<FilterSelect label="Auto refresh"><option>On</option><option>Off</option></FilterSelect>
```

`FilterSelect` is the inline caption+select used in toolbars and the dashboard action row, not a stacked field.
