import { test, expect } from '../fixtures/auth';
import { workspaceRoutes } from '../fixtures/routes';

/**
 * Navigation smoke: every workspace in the primary nav loads and renders its
 * root region, and none falls through to the not-found view. Data-layer errors
 * (e.g. an unavailable backend feature) still render the workspace shell, so
 * this proves routing + rendering without being brittle about live data.
 */
test.describe('Navigation smoke', () => {
  for (const route of workspaceRoutes) {
    test(`loads ${route.label} (${route.path})`, async ({ page }) => {
      await page.goto(route.path);

      // Authenticated shell is present.
      await expect(page.getByTestId('logout')).toBeVisible();
      // Route-specific workspace rendered.
      await expect(page.getByTestId(route.root)).toBeVisible();
      // Not the SPA 404.
      await expect(page.getByTestId('not-found')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${route.path.replace(/\//g, '\\/')}$`));
    });
  }
});
