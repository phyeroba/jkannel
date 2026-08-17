import React from 'react';

/* Card surface: no border in light theme, --shadow, 10px radius, 20px pad. */
export function Panel({ title, subtitle, action, wide, children, style, ...rest }) {
  return (
    <article className={wide ? 'panel wide' : 'panel'} style={style} {...rest}>
      {title || action ? (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </article>
  );
}
