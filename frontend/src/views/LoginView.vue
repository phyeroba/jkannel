<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '../stores/session';
import AppIcon from '../components/AppIcon.vue';
const router = useRouter();
const tenant = ref('default');
const username = ref(localStorage.getItem('jkannel-remembered-user') ?? '');
const password = ref('');
const remember = ref(Boolean(localStorage.getItem('jkannel-remembered-user')));
const showPassword = ref(false);
const error = ref('');
const busy = ref(false);
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await login(tenant.value, username.value, password.value);
    if (remember.value) localStorage.setItem('jkannel-remembered-user', username.value);
    else localStorage.removeItem('jkannel-remembered-user');
    await router.push('/dashboard/operations');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Login failed';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="login-page">
    <section class="login-visual" aria-label="JKANNEL platform overview">
      <div class="login-logo"><AppIcon name="sms" :size="27" /><strong>JKANNEL</strong></div>
      <!--
        WHAT THIS PANEL MUST NOT DO.

        It used to carry three figures — "Throughput 16k +8.2%", "Delivery rate
        98.7% last hour", "Connected SMSCs 12" — with two bar charts drawn from
        hardcoded arrays. None of it was measured. This deployment has three
        SMSCs, not twelve, and one of its carriers has been refusing the
        connection since 8 September.

        That is the exact thing the rest of this console refuses to do: §3.3
        and §17 are built on never presenting an unmeasured value as a measured
        one, and the first screen anybody sees was doing it in 19px bold. There
        is also nowhere honest to get real figures from here — this page is
        pre-authentication, and live throughput is not something to publish to
        an unauthenticated visitor.

        So the cards say what the platform DOES. No number appears that is not
        a protocol version.
      -->
      <div class="login-illustration" aria-hidden="true">
        <span class="illustration-ring"></span><span class="illustration-core"></span>
        <article class="login-stat first">
          <span class="stat-icon"><AppIcon name="link" :size="15" /></span>
          <strong>Carrier binds</strong>
          <small>
            SMPP 3.4 transmit, receive and transceiver — with the bind state as the poller observed
            it, never as it was assumed.
          </small>
        </article>
        <article class="login-stat second">
          <span class="stat-icon"><AppIcon name="receipt" :size="15" /></span>
          <strong>Receipts, traced</strong>
          <small>
            Each message followed from submit to the handset acknowledgement — or told plainly that
            no receipt came back.
          </small>
        </article>
        <article class="login-live">
          <AppIcon name="shield" :size="15" />
          <strong>Tenant isolated</strong>
          <small>Row-level security, enforced</small>
        </article>
      </div>
      <p class="login-caption">
        Interface with and extend Kamex or Kannel from one friendly control room for messaging,
        analytics and safe AI-assisted operations.
      </p>
    </section>
    <section class="login-form-wrap">
      <div class="login-card">
        <span class="login-console-badge">Admin Console</span>
        <h1>Welcome to JKANNEL! <span aria-hidden="true">👋</span></h1>
        <p>Please sign in to your account and start managing.</p>
        <form @submit.prevent="submit">
          <input v-model="tenant" type="hidden" data-testid="tenant" /><label for="login-username"
            >Email or Username</label
          ><input
            id="login-username"
            v-model="username"
            autocomplete="username"
            required
            data-testid="username"
          />
          <div class="password-label">
            <label for="login-password">Password</label
            ><RouterLink to="/reset-password" data-testid="forgot-password"
              >Forgot Password?</RouterLink
            >
          </div>
          <div class="password-field">
            <input
              id="login-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              required
              minlength="12"
              data-testid="password"
            /><button
              type="button"
              :aria-label="showPassword ? 'Hide password' : 'Show password'"
              @click="showPassword = !showPassword"
            >
              <AppIcon :name="showPassword ? 'eyeoff' : 'eye'" />
            </button>
          </div>
          <label class="remember-row"
            ><input v-model="remember" type="checkbox" /><span>Remember Me</span></label
          >
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <button class="primary-button" :disabled="busy" data-testid="login-submit">
            {{ busy ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>
      </div>
    </section>
  </main>
</template>
