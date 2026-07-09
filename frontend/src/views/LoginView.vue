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
      <div class="login-illustration" aria-hidden="true">
        <span class="illustration-ring"></span><span class="illustration-core"></span>
        <article class="login-stat first">
          <strong>Throughput</strong><small>Current traffic</small>
          <div class="mini-bars bars-one">
            <i
              v-for="height in [34, 55, 43, 72, 61, 88, 76, 100]"
              :key="height"
              :style="{ height: `${height}%` }"
            ></i>
          </div>
          <div><b>16k</b><em>+8.2%</em></div>
        </article>
        <article class="login-stat second">
          <strong>Delivery rate</strong><small>Last hour</small>
          <div class="mini-bars bars-two">
            <i
              v-for="height in [45, 35, 62, 49, 78, 66, 89, 82]"
              :key="height"
              :style="{ height: `${height}%` }"
            ></i>
          </div>
          <div><b>98.7%</b><em>+1.4%</em></div>
        </article>
        <article class="login-live"><small>Connected SMSCs</small><strong>12</strong></article>
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
