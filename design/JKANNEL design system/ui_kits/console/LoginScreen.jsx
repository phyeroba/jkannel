import React from 'react';
import { Icon } from '../../components/core/Icon.jsx';

/* Recreation of frontend/src/views/LoginView.vue — split screen, illustration
   left (rings + floating stat cards), form right. */
export function LoginScreen({ onSignIn }) {
  const [shown, setShown] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="login-logo"><Icon name="sms" size={38} /><strong>KAMEX</strong></div>
        <div className="login-illustration" aria-hidden="true">
          <span className="illustration-ring" />
          <span className="illustration-core" />
          <article className="login-stat first">
            <strong>Throughput</strong><small>Current traffic</small>
            <div className="mini-bars bars-one">{[34, 55, 43, 72, 61, 88, 76, 100].map((h, i) => <i key={i} style={{ height: h + '%' }} />)}</div>
            <div><b className="figures">16k</b><em>+8.2%</em></div>
          </article>
          <article className="login-stat second">
            <strong>Delivery rate</strong><small>Last hour</small>
            <div className="mini-bars bars-two">{[45, 35, 62, 49, 78, 66, 89, 82].map((h, i) => <i key={i} style={{ height: h + '%' }} />)}</div>
            <div><b className="figures">98.7%</b><em>+1.4%</em></div>
          </article>
          <article className="login-live"><small>Connected SMSCs</small><strong className="figures">12</strong></article>
        </div>
        <p className="login-caption">
          Interface with and extend Kamex or Kannel from one friendly control room for messaging,
          analytics and safe AI-assisted operations.
        </p>
      </section>
      <section className="login-form-wrap">
        <div className="login-card">
          <span className="login-console-badge">Operations Console</span>
          <h1>Gateway operations</h1>
          <p>Please sign in to your account and start managing.</p>
          <form onSubmit={(e) => { e.preventDefault(); setBusy(true); setTimeout(onSignIn, 350); }}>
            <label htmlFor="login-username">Email or Username</label>
            <input id="login-username" defaultValue="operator" autoComplete="username" required />
            <div className="password-label">
              <label htmlFor="login-password">Password</label>
              <span>Forgot Password?</span>
            </div>
            <div className="password-field">
              <input id="login-password" type={shown ? 'text' : 'password'} defaultValue="control-plane-1" minLength={12} required />
              <button type="button" aria-label={shown ? 'Hide password' : 'Show password'} onClick={() => setShown(!shown)}>
                <Icon name={shown ? 'eyeoff' : 'eye'} />
              </button>
            </div>
            <label className="remember-row"><input type="checkbox" defaultChecked /><span>Remember Me</span></label>
            <button className="primary-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        </div>
      </section>
    </main>
  );
}
