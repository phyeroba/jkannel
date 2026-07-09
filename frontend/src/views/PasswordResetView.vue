<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { apiPublicRequest } from '../api';
import AppIcon from '../components/AppIcon.vue';

const route = useRoute();
const token = computed(() => String(route.query.token ?? ''));
const isConfirm = computed(() => Boolean(token.value));

const tenant = ref('default');
const username = ref('');
const newPassword = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');
const requested = ref(false);
const devToken = ref('');
const confirmed = ref(false);

async function requestReset() {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    const result = await apiPublicRequest<{ devToken?: string }>('/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ tenant: tenant.value.trim(), username: username.value.trim() }),
    });
    devToken.value = typeof result?.devToken === 'string' ? result.devToken : '';
    requested.value = true;
  } catch (reason) {
    // Do not leak whether the account exists; only surface transport-level failures.
    error.value = reason instanceof Error ? reason.message : 'The request could not be completed.';
  } finally {
    busy.value = false;
  }
}

async function confirmReset() {
  if (busy.value) return;
  error.value = '';
  if (newPassword.value.length < 12) {
    error.value = 'Choose a password with at least 12 characters.';
    return;
  }
  busy.value = true;
  try {
    await apiPublicRequest('/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        tenant: tenant.value.trim(),
        newPassword: newPassword.value,
      }),
    });
    confirmed.value = true;
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : 'The reset link is invalid or has expired.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <div class="auth-brand"><AppIcon name="sms" :size="24" /><strong>JKANNEL</strong></div>

      <!-- Confirm mode: a reset token is present. -->
      <template v-if="isConfirm">
        <template v-if="confirmed">
          <h1>Password updated</h1>
          <p>Your password has been reset. You can now sign in with your new password.</p>
          <RouterLink
            class="primary-button auth-link-button"
            to="/login"
            data-testid="reset-login-link"
            >Go to sign in</RouterLink
          >
        </template>
        <template v-else>
          <h1>Set a new password</h1>
          <p>Enter your tenant and choose a new password to finish resetting your account.</p>
          <form @submit.prevent="confirmReset">
            <label for="reset-tenant">Tenant</label>
            <input id="reset-tenant" v-model="tenant" required data-testid="reset-tenant" />
            <label for="reset-password">New password</label>
            <div class="password-field">
              <input
                id="reset-password"
                v-model="newPassword"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                required
                minlength="12"
                data-testid="reset-new-password"
              /><button
                type="button"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <AppIcon :name="showPassword ? 'eyeoff' : 'eye'" />
              </button>
            </div>
            <p class="form-hint">Use at least 12 characters.</p>
            <p v-if="error" class="form-error" role="alert" data-testid="reset-error">
              {{ error }}
            </p>
            <button
              class="primary-button"
              :disabled="busy || !tenant.trim() || !newPassword"
              data-testid="reset-confirm-submit"
            >
              {{ busy ? 'Saving…' : 'Reset password' }}
            </button>
          </form>
        </template>
      </template>

      <!-- Request mode: no token, ask for tenant + username. -->
      <template v-else>
        <template v-if="requested">
          <h1>Check your inbox</h1>
          <p data-testid="reset-request-ack">
            If the account exists, a password reset was created. Follow the instructions sent to the
            account owner to continue.
          </p>
          <p v-if="devToken" class="auth-dev-token" data-testid="reset-dev-token">
            Development reset token: <code>{{ devToken }}</code>
          </p>
          <RouterLink class="text-link" to="/login">Back to sign in</RouterLink>
        </template>
        <template v-else>
          <h1>Forgot your password?</h1>
          <p>Enter your tenant and username and we will create a reset if the account exists.</p>
          <form @submit.prevent="requestReset">
            <label for="request-tenant">Tenant</label>
            <input id="request-tenant" v-model="tenant" required data-testid="request-tenant" />
            <label for="request-username">Username</label>
            <input
              id="request-username"
              v-model="username"
              autocomplete="username"
              required
              data-testid="request-username"
            />
            <p v-if="error" class="form-error" role="alert" data-testid="request-error">
              {{ error }}
            </p>
            <button
              class="primary-button"
              :disabled="busy || !tenant.trim() || !username.trim()"
              data-testid="request-submit"
            >
              {{ busy ? 'Requesting…' : 'Request reset' }}
            </button>
          </form>
          <p class="auth-footer"><RouterLink to="/login">Back to sign in</RouterLink></p>
        </template>
      </template>
    </section>
  </main>
</template>
