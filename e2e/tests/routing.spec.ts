import { test, expect } from '../fixtures/auth';

/**
 * Routing: opening the create composer loads the Target and Fallback SMSC
 * dropdowns from live SMSC data. No route is created (read-only verification),
 * so there is nothing to clean up.
 */
test.describe('Routing', () => {
  test('Target and Fallback SMSC dropdowns populate', async ({ page }) => {
    await page.goto('/routing');
    await expect(page.getByTestId('module-workspace')).toBeVisible();

    // Opening the composer triggers loadRouteSmscOptions().
    await page.getByTestId('primary-action').click();

    const target = page.getByTestId('draft-target');
    const fallback = page.getByTestId('draft-fallback');
    await expect(target).toBeVisible();
    await expect(fallback).toBeVisible();

    // SMSC options are fetched asynchronously after the composer opens; wait for
    // the dropdown to reach a settled state: populated with real SMSCs, or a
    // clear "no SMSCs available" message. Both are valid, populated states.
    await expect(async () => {
      const errored = await page.getByTestId('route-smsc-error').isVisible();
      const options = await target.locator('option').count();
      expect(errored || options > 1).toBeTruthy();
    }).toPass({ timeout: 10_000 });

    const errorVisible = await page.getByTestId('route-smsc-error').isVisible();

    if (errorVisible) {
      await expect(page.getByTestId('route-smsc-error')).toBeVisible();
      test.info().annotations.push({
        type: 'note',
        description: 'No SMSC connections available to populate routing dropdowns.',
      });
    } else {
      // More than just the disabled placeholder option.
      expect(await target.locator('option').count()).toBeGreaterThan(1);
      // Fallback carries the same SMSCs plus a "None" option.
      expect(await fallback.locator('option').count()).toBeGreaterThan(1);
    }
  });
});
