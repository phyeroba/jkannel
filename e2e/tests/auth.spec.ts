import { test, expect, loginViaUi } from '../fixtures/auth';
import { OPERATOR } from '../fixtures/env';

/**
 * Auth workflows. These run WITHOUT the seeded storageState so the real login
 * form is exercised end to end.
 */
test.describe('Authentication', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login succeeds with valid operator credentials', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();

    await page.getByTestId('username').fill(OPERATOR.username);
    await page.getByTestId('password').fill(OPERATOR.password);
    await page.getByTestId('login-submit').click();

    await page.waitForURL('**/dashboard/operations');
    // The authenticated shell renders the logout control.
    await expect(page.getByTestId('logout')).toBeVisible();
  });

  test('login fails with a wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('username').fill(OPERATOR.username);
    // Meets the min-length client constraint but is not the real password.
    await page.getByTestId('password').fill('WrongPassword!9999');
    await page.getByTestId('login-submit').click();

    // Error surfaces and we stay on the login page.
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('logout')).toHaveCount(0);
  });

  test('logout returns the operator to the login page', async ({ page }) => {
    await loginViaUi(page);
    await expect(page.getByTestId('logout')).toBeVisible();

    await page.getByTestId('logout').click();

    await page.waitForURL('**/login');
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });
});
