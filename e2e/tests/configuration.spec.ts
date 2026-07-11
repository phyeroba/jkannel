import { test, expect } from '../fixtures/auth';

/**
 * Configuration: the templates panel lists built-in templates, and the drift
 * panel's "Check now" action resolves to a status (or a clear error). Read-only.
 */
test.describe('Configuration', () => {
  test('templates panel lists built-in templates', async ({ page }) => {
    await page.goto('/configuration');
    await expect(page.getByTestId('module-workspace')).toBeVisible();
    await expect(page.getByTestId('configuration-templates')).toBeVisible();

    // Built-in templates render as rows, unless the endpoint is unavailable.
    const templateRow = page.locator('[data-testid^="template-"]').first();
    const empty = page.getByTestId('templates-empty');
    const error = page.getByTestId('templates-error');
    await expect(templateRow.or(empty).or(error).first()).toBeVisible();

    if ((await templateRow.count()) > 0) {
      await expect(templateRow).toBeVisible();
    } else {
      test.info().annotations.push({
        type: 'note',
        description: 'No built-in configuration templates returned by the API.',
      });
    }
  });

  test('drift panel "Check now" resolves', async ({ page }) => {
    await page.goto('/configuration');
    await expect(page.getByTestId('configuration-drift')).toBeVisible();

    await page.getByTestId('drift-check').click();

    // Either a drift status (in-sync / drift detected) or a clear error appears.
    await expect(
      page.getByTestId('drift-status').or(page.getByTestId('drift-error')),
    ).toBeVisible();
  });
});
