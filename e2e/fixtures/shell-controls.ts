import { expect, type Locator, type Page } from "@playwright/test";

/** Follow the visible product entry point, including the focused first visit. */
export async function openSettings(page: Page): Promise<Locator> {
  const dialog = page.locator("#settings-dialog");
  if (!(await dialog.isVisible())) {
    const welcome = page.locator("#welcome-settings");
    const compact = page.locator("#rail-settings");
    if (await welcome.isVisible()) await welcome.click();
    else if (await compact.isVisible()) await compact.click();
    else {
      await page.locator("#more-options > summary").click();
      await page.locator("#settings").click();
    }
  }
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function openSettingsSection(dialog: Locator, title: string) {
  const summary = dialog
    .locator("summary")
    .filter({ hasText: new RegExp(`^${title}$`) });
  const open = await summary.evaluate(
    (node) => (node.parentElement as HTMLDetailsElement).open,
  );
  if (!open) await summary.click();
}

export async function createAppFromGoal(
  page: Page,
  goal: string,
  name?: string,
) {
  const welcome = page.locator("#welcome-create");
  await (
    (await welcome.isVisible()) ? welcome : page.locator("#new-app")
  ).click();
  const dialog = page.locator("#create-dialog");
  await dialog
    .getByLabel("What would you like to do?", { exact: true })
    .fill(goal);
  if (name !== undefined)
    await dialog.getByLabel("App name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create app", exact: true }).click();
}
