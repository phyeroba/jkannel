import React from 'react';
import { Icon } from './Icon.jsx';

/* Three shipped button classes: primary (filled violet), secondary (hairline
   on surface), danger (bad-tinted). Plus the transparent icon button. */
export function Button({ variant = 'primary', icon, children, style, ...rest }) {
  const cls =
    variant === 'secondary' ? 'secondary-button' : variant === 'danger' ? 'danger-button' : 'primary-button';
  return (
    <button className={cls} style={style} {...rest}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, size = 18, ...rest }) {
  return (
    <button className="icon-button" aria-label={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}
