import { test, expect } from '../fixtures/auth';
import { uniqueName } from '../fixtures/env';

/**
 * Analytics & Reports: the analytics panels render, the saved report-definition
 * list loads, and a definition can be created and deleted. Each analytics panel
 * resolves to one of a small set of terminal states (data / empty / error) —
 * asserting "one of them is visible" proves the panel rendered without being
 * brittle about live telemetry.
 */
test.describe('Analytics & Reports', () => {
  const panelStates: Record<string, string[]> = {
    'smsc-success': [
      'smsc-success-chart',
      'smsc-success-table',
      'smsc-success-empty',
      'smsc-success-unavailable',
    ],
    'route-performance': [
      'route-performance-chart',
      'route-performance-table',
      'route-performance-empty',
      'route-performance-unavailable',
    ],
    heatmap: ['heatmap', 'heatmap-empty', 'heatmap-unavailable'],
    latency: ['latency-cards', 'latency-empty', 'latency-unavailable'],
  };

  test('analytics panels render', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByTestId('analytics-view')).toBeVisible();

    for (const [panel, states] of Object.entries(panelStates)) {
      const anyState = states.map((id) => page.getByTestId(id)).reduce((acc, loc) => acc.or(loc));
      await expect(anyState, `panel "${panel}" reached a terminal render state`).toBeVisible();
    }
  });

  test('saved report definitions list loads, and a definition can be created then deleted', async ({
    page,
    api,
  }) => {
    let createdId: string | null = null;
    await page.goto('/reports');
    await expect(page.getByTestId('analytics-view')).toBeVisible();

    // The definitions region loads (table, empty state, or unavailable notice).
    const defRegion = page
      .getByTestId('definition-empty')
      .or(page.getByTestId('definition-unavailable'))
      .or(page.locator('[data-testid^="definition-"]').first());
    await expect(defRegion.first()).toBeVisible();

    const newButton = page.getByTestId('definition-new');
    await expect(newButton).toBeVisible();
    if (await newButton.isDisabled()) {
      test.info().annotations.push({
        type: 'note',
        description: 'No available report kinds — definition creation skipped.',
      });
      return;
    }

    try {
      const name = uniqueName('report-def');
      await newButton.click();
      await expect(page.getByTestId('definition-form')).toBeVisible();
      await page.getByTestId('definition-name').fill(name);
      // definition-type defaults to the first available kind; format/schedule keep defaults.

      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/reports/definitions') && r.request().method() === 'POST',
        ),
        page.getByTestId('definition-submit').click(),
      ]);
      expect(resp.ok()).toBeTruthy();
      const created = await resp.json();
      createdId = String((created.data ?? created).id);

      // The new definition appears in the list.
      const row = page.getByRole('row').filter({ hasText: name });
      await expect(row).toBeVisible();

      // Delete it (native confirm dialog).
      page.once('dialog', (d) => d.accept());
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/reports/definitions/') && r.request().method() === 'DELETE',
        ),
        page.getByTestId(`definition-delete-${createdId}`).click(),
      ]);
      await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
      createdId = null;
    } finally {
      if (createdId) {
        await api.delete(`/reports/definitions/${createdId}`).catch(() => undefined);
      }
    }
  });
});
