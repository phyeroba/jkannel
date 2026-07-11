import { test, expect } from '../fixtures/auth';
import { uniqueName } from '../fixtures/env';

/**
 * SMSC connection lifecycle: list -> open detail -> create -> edit -> delete.
 * A uniquely-named "fake" SMSC is created (no host/port required) and removed
 * again. A worker-scoped API client provides a safety-net delete so nothing is
 * left behind even if a UI step fails.
 */
test.describe('SMSC connections', () => {
  let createdId: string | null = null;

  test.afterEach(async ({ api }) => {
    if (createdId) {
      // Idempotent safety net; ignore 404/409 if the UI already removed it.
      await api.delete(`/smscs/${createdId}`).catch(() => undefined);
      createdId = null;
    }
  });

  test('lists connections and opens a detail panel', async ({ page }) => {
    await page.goto('/smsc');
    await expect(page.getByTestId('module-workspace')).toBeVisible();

    // Wait for the grid to settle: either rows appear, or the empty state does.
    const rows = page.locator('[data-testid^="record-"]');
    await expect(async () => {
      const rowCount = await rows.count();
      const empty = await page.getByTestId('empty-state').isVisible();
      expect(rowCount > 0 || empty).toBeTruthy();
    }).toPass({ timeout: 15_000 });

    if ((await rows.count()) === 0) {
      // Fresh environments may have no SMSCs; the grid still loaded correctly.
      await expect(page.getByTestId('empty-state')).toBeVisible();
      test.info().annotations.push({ type: 'note', description: 'No SMSC rows to open.' });
      return;
    }

    // Clicking the row (outside the action cell) opens the detail drawer.
    await rows.first().getByRole('cell').first().click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await expect(page.getByTestId('smsc-health')).toBeVisible();
    await page.getByTestId('detail-close').click();
    await expect(page.getByTestId('detail-panel')).toHaveCount(0);
  });

  test('creates, edits, and deletes a fake SMSC', async ({ page }) => {
    const name = uniqueName('smsc');
    await page.goto('/smsc');
    await expect(page.getByTestId('module-workspace')).toBeVisible();

    // Open the composer and fill the create form (defaults to a "fake" SMSC).
    await page.getByTestId('primary-action').click();
    await expect(page.getByTestId('draft-name')).toBeVisible();
    await page.getByTestId('draft-name').fill(name);

    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/smscs') && r.request().method() === 'POST',
      ),
      page.getByTestId('save-draft').click(),
    ]);
    expect(createResp.ok()).toBeTruthy();
    const createdBody = await createResp.json();
    createdId = String((createdBody.data ?? createdBody).id);
    expect(createdId).toBeTruthy();

    // The new connection appears in the grid (filter by its unique name).
    await page.getByTestId('workspace-search').fill(name);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();

    // Open detail and edit the TPS via the edit form.
    await row.getByRole('cell').first().click();
    await expect(page.getByTestId('detail-panel')).toBeVisible();
    await page.getByTestId('smsc-edit').click();
    await expect(page.getByTestId('smsc-edit-form')).toBeVisible();
    await page.getByTestId('smsc-edit-tps').fill('42');
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/smscs/${createdId}`) &&
          ['PATCH', 'PUT'].includes(r.request().method()),
      ),
      page.getByTestId('smsc-save').click(),
    ]);

    // Delete/Archive it (the app uses a native confirm dialog). Archiving is a
    // soft delete: the DELETE call succeeds and the connection moves to the
    // "archived" lifecycle rather than vanishing from the grid.
    page.once('dialog', (d) => d.accept());
    const [deleteResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/smscs/${createdId}`) && r.request().method() === 'DELETE',
      ),
      page.getByTestId('smsc-archive').click(),
    ]);
    expect(deleteResp.ok()).toBeTruthy();

    // Archive completes: the detail drawer closes and the success notice shows.
    await expect(page.getByTestId('detail-panel')).toHaveCount(0);
    await expect(page.getByTestId('operation-success')).toContainText(/archived/i);
    // Leave createdId set so the afterEach API safety net runs idempotently.
  });
});
