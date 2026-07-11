import { test, expect } from '../fixtures/auth';

/**
 * Messages: the grid loads and a row opens the trace drawer with its event
 * timeline. Read-only; no cleanup required.
 */
test.describe('Messages', () => {
  test('grid loads and a row opens the trace drawer', async ({ page }) => {
    await page.goto('/messages');
    await expect(page.getByTestId('module-workspace')).toBeVisible();

    // Wait for the grid to settle: either rows appear, or the empty state does.
    const rows = page.locator('[data-testid^="record-"]');
    await expect(async () => {
      const rowCount = await rows.count();
      const empty = await page.getByTestId('empty-state').isVisible();
      expect(rowCount > 0 || empty).toBeTruthy();
    }).toPass({ timeout: 15_000 });

    if ((await rows.count()) === 0) {
      await expect(page.getByTestId('empty-state')).toBeVisible();
      test.info().annotations.push({ type: 'note', description: 'No messages to trace.' });
      return;
    }

    await rows.first().click();
    await expect(page.getByTestId('message-trace-panel')).toBeVisible();
    await expect(page.getByTestId('message-trace-events')).toBeVisible();

    await page.getByTestId('message-trace-close').click();
    await expect(page.getByTestId('message-trace-panel')).toHaveCount(0);
  });
});
