import { request } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API_BASE, BASE_URL, OPERATOR, STORAGE_STATE, TOKEN_KEYS } from './fixtures/env';

/**
 * Authenticates the operator ONCE via the REST API and writes a Playwright
 * storageState file that seeds the SPA's localStorage tokens. Every spec then
 * boots already-authenticated, so specs never re-login serially. The dedicated
 * auth spec opts back out to an empty state to exercise the real login form.
 */
export default async function globalSetup(): Promise<void> {
  if (!OPERATOR.password) {
    throw new Error(
      'E2E_OPERATOR_PASSWORD is not set. Export the operator password before running the suite, ' +
        "e.g. E2E_OPERATOR_PASSWORD='...' npx playwright test",
    );
  }

  const ctx = await request.newContext();
  const res = await ctx.post(`${API_BASE}/auth/login`, {
    data: {
      tenant: OPERATOR.tenant,
      username: OPERATOR.username,
      password: OPERATOR.password,
    },
  });

  if (!res.ok()) {
    throw new Error(
      `Global auth setup failed: POST ${API_BASE}/auth/login returned ${res.status()}.\n` +
        `Is the stack running and the password correct?\n${await res.text()}`,
    );
  }

  const body = await res.json();
  const data = body.data ?? body;
  const accessToken: string = data.accessToken;
  const refreshToken: string = data.refreshToken;
  if (!accessToken || !refreshToken) {
    throw new Error(`Login response did not contain tokens: ${JSON.stringify(body)}`);
  }

  const origin = new URL(BASE_URL).origin;
  const state = {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: TOKEN_KEYS.access, value: accessToken },
          { name: TOKEN_KEYS.refresh, value: refreshToken },
        ],
      },
    ],
  };

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });
  fs.writeFileSync(STORAGE_STATE, JSON.stringify(state, null, 2));
  await ctx.dispose();
}
