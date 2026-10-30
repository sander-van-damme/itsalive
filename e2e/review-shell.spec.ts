import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function capture(page: Page, name: string) {
  await mkdir("work/screenshots", { recursive: true });
  await page.screenshot({
    path: `work/screenshots/review-shell-${name}.png`,
    fullPage: true,
  });
}

async function open(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
}

async function createFixture(page: Page) {
  await page.evaluate(() => window.__itsalive.createApp("Practice notebook"));
  await expect(page.locator("#shell")).toHaveClass(/has-app/);
  await expect(page.locator('iframe[data-mode="app"]')).toBeAttached();
}

test("first visit is focused on a goal and examples remain editable before creation", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("heading", { name: "What would you like to do?" }),
  ).toBeVisible();
  await expect(page.locator(".rail")).toBeHidden();
  await expect(page.locator("#chat-form")).toBeHidden();
  await capture(page, "welcome");
  await page.locator("[data-goal]").first().click();
  await expect(page.locator("#create-dialog")).toBeVisible();
  await expect(page.locator('#create-form textarea[name="idea"]')).toHaveValue(
    "Help me learn to play violin chords.",
  );
  expect(await page.evaluate(() => window.__itsalive.listApps())).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator("#welcome-settings").click();
  await expect(page.locator("#settings-dialog")).toBeVisible();
});

test("left sidebar collapses to working shortcuts and preserves the mounted application", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await createFixture(page);
  const rail = await page.locator(".rail").boundingBox();
  const frame = await page.locator('iframe[data-mode="app"]').boundingBox();
  expect(rail!.x).toBeLessThan(frame!.x);
  expect(rail!.width).toBeLessThanOrEqual(400);
  await page.locator('iframe[data-mode="app"]').evaluate((element) => {
    (window as any).__reviewFrame = element;
  });
  const collapseIcon = await page.locator("#rail-toggle").innerHTML();
  await page
    .getByRole("button", { name: "Collapse assistant", exact: true })
    .click();
  await expect(page.locator("#rail-content")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Expand assistant", exact: true }),
  ).toBeVisible();
  expect(await page.locator("#rail-toggle").innerHTML()).not.toBe(collapseIcon);
  for (const selector of [
    "#app-switcher > summary",
    "#new-app",
    "#rail-chat",
    "#rail-history",
    "#speak",
    "#workspace-spend",
    "#speed-menu > summary",
    "#rail-settings",
  ]) {
    await expect(page.locator(selector)).toBeVisible();
  }
  const expandedFrame = await page
    .locator('iframe[data-mode="app"]')
    .boundingBox();
  expect(expandedFrame!.width).toBeGreaterThan(frame!.width);
  expect(
    await page
      .locator('iframe[data-mode="app"]')
      .evaluate((element) => element === (window as any).__reviewFrame),
  ).toBe(true);
  await capture(page, "collapsed");
  await page.locator("#rail-history").click();
  await expect(page.locator("#history")).toBeVisible();
  await page
    .getByRole("button", { name: "Back to application", exact: true })
    .click();
  await page.locator("#rail-chat").click();
  await expect(page.locator("#message")).toBeFocused();
});

test("appearance persists and the live conversation entry is separate from text composition", async ({
  page,
}) => {
  await open(page);
  await createFixture(page);
  await expect(page.locator("#chat-form #speak")).toHaveCount(0);
  await expect(page.locator("#speak")).toBeVisible();
  await page.locator("#theme-menu > summary").click();
  await page.locator("#theme-choice").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const starter = page.frameLocator('iframe[data-mode="app"]').locator("body");
  await expect(starter).toHaveCSS("background-color", "rgb(24, 33, 30)");
  await page.locator("#theme-choice").selectOption("light");
  await expect(starter).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#theme-choice").selectOption("dark");
  await expect(starter).toHaveCSS("background-color", "rgb(24, 33, 30)");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => localStorage.getItem("itsalive.theme")),
  ).toBe("dark");
  await expect(page.locator('iframe[data-mode="app"]')).toBeAttached();
  await expect(
    page.frameLocator('iframe[data-mode="app"]').locator("body"),
  ).toHaveCSS("background-color", "rgb(24, 33, 30)");
  await capture(page, "dark");
});

test("mobile first visit and assistant controls fit without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.locator("#welcome")).toBeVisible();
  await expect(page.locator(".mobile-navigation")).toBeHidden();
  await capture(page, "mobile-welcome");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await createFixture(page);
  await page
    .getByRole("button", { name: "View assistant", exact: true })
    .click();
  await expect(page.locator("#speak")).toBeVisible();
  await expect(page.locator("#workspace-spend")).toBeVisible();
  await expect(page.locator("#message")).toBeVisible();
  await capture(page, "mobile-assistant");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
