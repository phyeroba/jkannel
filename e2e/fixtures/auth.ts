import fs from 'node:fs';
import {
  test as base,
  expect,
  request,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { API_BASE, OPERATOR, STORAGE_STATE, TOKEN_KEYS } from './env';

/**
 * `api` is a worker-scoped, operator-authenticated REST client used as a
 * reliable safety net to delete any entity a spec creates, independent of
 * whatever the UI did — so the system is never left polluted even if a UI
 * assertion fails mid-test.
 *
 * It reuses the access token minted once by global-setup (persisted in the
 * storageState file) rather than logging in again. Re-logging in per worker
 * multiplies auth attempts against the account, which risks tripping the
 * server-side failed-login lockout during a parallel run.
 */
type WorkerFixtures = {
  api: APIRequestContext;
};

function tokenFromStorageState(): string {
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8')) as {
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
  };
  const entry = state.origins?.[0]?.localStorage?.find((e) => e.name === TOKEN_KEYS.access);
  if (!entry?.value) {
    throw new Error(
      `No access token found in ${STORAGE_STATE}. Did global-setup run? Is the stack up?`,
    );
  }
  return entry.value;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  api: [
    async ({}, use) => {
      const authed = await request.newContext({
        baseURL: API_BASE,
        extraHTTPHeaders: { authorization: `Bearer ${tokenFromStorageState()}` },
      });
      await use(authed);
      await authed.dispose();
    },
    { scope: 'worker' },
  ],
});

export { expect };

/**
 * Logs in through the real SPA form. Used only by the auth spec, which runs in
 * a fresh (unauthenticated) context; everything else relies on the seeded
 * storageState from global-setup.
 */
export async function loginViaUi(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('username').fill(OPERATOR.username);
  await page.getByTestId('password').fill(OPERATOR.password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/dashboard/operations');
}
