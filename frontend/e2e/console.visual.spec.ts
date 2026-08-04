import { expect, test, type Page } from '@playwright/test';

const tenant = process.env.JKANNEL_E2E_TENANT ?? 'default';
const username = process.env.JKANNEL_E2E_USERNAME ?? 'operator';
const password = process.env.JKANNEL_E2E_PASSWORD;

async function login(page: Page) {
  if (!password)
    throw new Error('JKANNEL_E2E_PASSWORD is required; keep it outside source control.');
  await page.goto('/login');
  await page.getByTestId('tenant').fill(tenant);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/dashboard\/operations$/);
}

test('@visual login follows the canonical responsive design', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.removeItem('jkannel-console-theme'));
  await page.goto('/login');
  const visualBrand = page.getByLabel('JKANNEL platform overview');
  if (testInfo.project.name === 'mobile-chrome') await expect(visualBrand).toBeHidden();
  else await expect(visualBrand).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to JKANNEL! 👋' })).toBeVisible();
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      primary: root.getPropertyValue('--brand').trim(),
      background: root.getPropertyValue('--bg').trim(),
      font: root.fontFamily,
    };
  });
  expect(tokens.primary).toBe('#7367f0');
  expect(tokens.background).toBe('#f8f7fa');
  expect(tokens.font).toContain('Public Sans');
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true });
});

test('@visual authenticated console uses grouped SVG navigation', async ({ page }, testInfo) => {
  await login(page);
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation' });
  await expect(sidebar.getByText('Messaging', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Insights', { exact: true })).toBeVisible();
  await expect(sidebar.getByText('Platform', { exact: true })).toBeVisible();
  // Assert the invariant (every navigation entry renders an SVG icon) rather than
  // a hard-coded total. The previous literal count silently rotted as navigation
  // grew, and it also varies with the signed-in user's permissions, so a fixed
  // number tests the fixture more than the UI.
  const navIcons = sidebar.locator('.nav-icon svg');
  const navLinks = sidebar.locator('.nav-group a');
  await expect(navLinks.first()).toBeVisible();
  expect(await navIcons.count()).toBe(await navLinks.count());
  expect(await navIcons.count()).toBeGreaterThanOrEqual(10);
  const scrolling = await sidebar.evaluate((element) => {
    const nav = element.querySelector('nav')!;
    return { sidebar: getComputedStyle(element).overflowY, nav: getComputedStyle(nav).overflowY };
  });
  expect(scrolling).toEqual({ sidebar: 'hidden', nav: 'auto' });
  await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('operations-console.png'), fullPage: true });
});

test('core navigation remains interactive', async ({ page }, testInfo) => {
  await login(page);
  if (testInfo.project.name === 'mobile-chrome')
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'SMSC Connections' }).click();
  await expect(page).toHaveURL(/\/smsc$/);
  await expect(page.getByRole('heading', { name: 'SMSC Manager', level: 1 })).toBeVisible();
  if (testInfo.project.name === 'mobile-chrome')
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Routing' }).click();
  await expect(page).toHaveURL(/\/routing$/);
});
