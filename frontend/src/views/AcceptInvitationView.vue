<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, apiPublicRequest } from '../api';
import AppIcon from '../components/AppIcon.vue';

const route = useRoute();
const token = computed(() => String(route.query.token ?? ''));
const username = ref('');
const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');
const done = ref(false);

async function submit() {
  if (busy.value) return;
  error.value = '';
  if (!token.value) {
    error.value = 'This invitation link is missing its token. Request a new invitation.';
    return;
  }
  if (password.value.length < 12) {
    error.value = 'Choose a password with at least 12 characters.';
    return;
  }
  busy.value = true;
  try {
    await apiPublicRequest('/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        username: username.value.trim(),
        password: password.value,
      }),
    });
    done.value = true;
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) {
      error.value = 'That username is already taken. Choose a different username.';
    } else if (reason instanceof ApiError && reason.status === 400) {
      error.value = 'This invitation is invalid or has expired. Request a new invitation.';
    } else {
      error.value =
        reason instanceof Error ? reason.message : 'The invitation could not be accepted.';
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <div class="auth-brand"><AppIcon name="sms" :size="24" /><strong>JKANNEL</strong></div>
      <template v-if="done">
        <h1>Account ready</h1>
        <p>Your account has been created. You can now sign in with your new credentials.</p>
        <RouterLink
          class="primary-button auth-link-button"
          to="/login"
          data-testid="accept-login-link"
          >Go to sign in</RouterLink
        >
      </template>
      <template v-else>
        <h1>Accept your invitation</h1>
        <p>Choose a username and password to activate your JKANNEL account.</p>
        <form @submit.prevent="submit">
          <label for="accept-username">Username</label>
          <input
            id="accept-username"
            v-model="username"
            autocomplete="username"
            required
            data-testid="accept-username"
          />
          <label for="accept-password">Password</label>
          <div class="password-field">
            <input
              id="accept-password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              required
              minlength="12"
              data-testid="accept-password"
            /><button
              type="button"
              :aria-label="showPassword ? 'Hide password' : 'Show password'"
              @click="showPassword = !showPassword"
            >
              <AppIcon :name="showPassword ? 'eyeoff' : 'eye'" />
            </button>
          </div>
          <p class="form-hint">Use at least 12 characters.</p>
          <p v-if="error" class="form-error" role="alert" data-testid="accept-error">{{ error }}</p>
          <button
            class="primary-button"
            :disabled="busy || !username.trim() || !password"
            data-testid="accept-submit"
          >
            {{ busy ? 'Activating…' : 'Activate account' }}
          </button>
        </form>
        <p class="auth-footer">
          Already have an account? <RouterLink to="/login">Sign in</RouterLink>
        </p>
      </template>
    </section>
  </main>
</template>
