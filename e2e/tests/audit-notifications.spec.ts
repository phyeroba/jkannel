import { test, expect } from '../fixtures/auth';

/**
 * Audit log + notifications. The audit grid loads and rows open the audit-event
 * detail; the notification bell opens the panel and an item shows its detail.
 * Read-only.
 */
test.describe('Audit & Notifications', () => {
  test('audit grid loads and a row opens the event detail', async ({ page }) => {
    await page.goto('/logs-audit');
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
      test.info().annotations.push({ type: 'note', description: 'No audit events recorded.' });
      return;
    }

    await rows.first().getByRole('cell').first().click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('detail-close').click();
    await expect(page.getByTestId('detail-panel')).toHaveCount(0);
  });

  test('notification bell opens the panel and an item shows detail', async ({ page }) => {
    await page.goto('/dashboard/operations');
    await expect(page.getByTestId('logout')).toBeVisible();

    await page.getByTestId('notifications-bell').click();
    // The panel is open (its "Mark all read" control is present).
    await expect(page.getByTestId('mark-all-read')).toBeVisible();

    // Notification panel items are `notification-<id>`; exclude the detail dialog testids.
    const items = page.locator(
      '[data-testid^="notification-"]:not([data-testid="notification-detail"]):not([data-testid="notification-detail-close"])',
    );
    if ((await items.count()) === 0) {
      test.info().annotations.push({ type: 'note', description: 'No notifications to open.' });
      return;
    }

    await items.first().click();
    await expect(page.getByTestId('notification-detail')).toBeVisible();
    await page.getByTestId('notification-detail-close').click();
    await expect(page.getByTestId('notification-detail')).toHaveCount(0);
  });
});
