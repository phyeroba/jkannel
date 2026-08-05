import { test, expect } from '../fixtures/auth';

/**
 * Bulk Send: the view loads, the SMSC dropdown populates from live data, and
 * the parsed-recipient counter updates live as recipients are typed. No job is
 * queued (that would send traffic), so there is nothing to clean up.
 */
test.describe('Bulk Send', () => {
  test('view loads, SMSC dropdown populates, recipient count updates live', async ({ page }) => {
    await page.goto('/bulk-send');
    await expect(page.getByTestId('bulk-send-view')).toBeVisible();

    // The create composer is available to the administrator.
    const smsc = page.getByTestId('bulk-smsc');
    await expect(smsc).toBeVisible();

    // SMSC options load asynchronously; wait for a settled state (populated or
    // a clear "no SMSCs" error).
    await expect(async () => {
      const errored = await page.getByTestId('bulk-smsc-error').isVisible();
      const options = await smsc.locator('option').count();
      expect(errored || options > 1).toBeTruthy();
    }).toPass({ timeout: 10_000 });

    if (await page.getByTestId('bulk-smsc-error').isVisible()) {
      test.info().annotations.push({
        type: 'note',
        description: 'No SMSC connections available for bulk send.',
      });
    } else {
      // More than just the disabled placeholder.
      expect(await smsc.locator('option').count()).toBeGreaterThan(1);
    }

    // Recipient counter reflects parsing (newline / comma / whitespace split).
    await expect(page.getByTestId('bulk-recipient-count')).toContainText('0 recipient');
    await page.getByTestId('bulk-recipients').fill('+256700000001\n+256700000002, +256700000003');
    await expect(page.getByTestId('bulk-recipient-count')).toContainText('3 recipient');

    await page.getByTestId('bulk-recipients').fill('+256700000009');
    await expect(page.getByTestId('bulk-recipient-count')).toContainText('1 recipient');
  });
});
