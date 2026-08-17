import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Field({ label, hint, children, ...rest }) {
  return (
    <label className="field" {...rest}>
      <span>{label}</span>
      {children}
      {hint ? <small style={{ color: 'var(--muted)', fontSize: 12 }}>{hint}</small> : null}
    </label>
  );
}

export function TextInput({ label, hint, ...rest }) {
  return (
    <Field label={label} hint={hint}>
      <input {...rest} />
    </Field>
  );
}

export function PasswordInput({ label = 'Password', ...rest }) {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="field" style={{ position: 'relative' }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-strong)' }}>{label}</span>
      <div style={{ position: 'relative' }}>
        <input type={shown ? 'text' : 'password'} style={{ paddingRight: 40 }} {...rest} />
        <button
          type="button"
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown(!shown)}
          style={{
            position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)',
            display: 'flex', border: 0, background: 'transparent', color: 'var(--muted)', padding: 4, cursor: 'pointer',
          }}
        >
          <Icon name={shown ? 'eyeoff' : 'eye'} />
        </button>
      </div>
    </div>
  );
}

export function FilterSelect({ label, children, ...rest }) {
  return (
    <label className="filter-select">
      <span>{label}</span>
      <select {...rest}>{children}</select>
    </label>
  );
}
