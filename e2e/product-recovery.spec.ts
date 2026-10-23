import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installGoalProvider } from "./fixtures/goal-provider";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
}
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function openSettings(page: Page) {
  if (await page.locator("#settings-dialog").isVisible()) return;
  await page.locator("#more-options > summary").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
async function connect(page: Page) {
  const dialog = page.locator("#settings-dialog");
  if (!(await dialog.isVisible())) await openSettings(page);
  await dialog
    .getByRole("combobox", { name: "Connect with", exact: true })
    .selectOption("openai");
  await dialog
    .getByLabel("OpenAI API key", { exact: true })
    .fill("acceptance-test-credential");
  await dialog
    .getByRole("button", { name: /^(Connect and save|Save settings)$/ })
    .click();
  await expect(dialog).not.toBeVisible();
}
async function createGoal(page: Page) {
  await send(page, "I want an app that teaches me violin chords and scales.");
  await expect(
    page
      .frameLocator('iframe[data-mode="app"]')
      .getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#status")).toContainText(/ready/i);
}
const app = (page: Page) => page.frameLocator('iframe[data-mode="app"]');
const revision = (page: Page) =>
  page.evaluate(async () => (await window.__itsalive.getRevision()).id);
async function screenshot(page: Page, name: string) {
  await mkdir("work/screenshots", { recursive: true });
  await page.screenshot({
    path: `work/screenshots/${name}.png`,
    fullPage: true,
  });
}
async function fixture(page: Page, context: BrowserContext) {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  await createGoal(page);
  return provider;
}

test("first run resumes a goal after provider setup, creates useful practice and keeps engineering hidden", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await expect(page.locator("#provider-badge")).not.toContainText(/demo/i);
  await send(page, "I want an app that teaches me violin chords and scales.");
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await expect(page.locator("#settings-dialog")).toContainText(
    /connect|provider|AI/i,
  );
  expect(provider.requests).toHaveLength(0);
  await screenshot(page, "after-onboarding-desktop");
  await connect(page);
  await expect(
    app(page).getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply change", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Source code", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Source", exact: true }),
  ).not.toBeVisible();
  await expect(page.locator("#chat")).not.toContainText(
    /React|compiled|write_file|coding harness|file.editing/i,
  );
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
  await app(page)
    .getByRole("button", { name: "Mark practice complete", exact: true })
    .click();
  await expect(
    app(page).getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  const before = await revision(page);
  const codingBefore = provider.requests.filter(
    (request) => request.tools,
  ).length;
  await send(page, "Why is this chord difficult?");
  await expect(page.locator("#chat")).toContainText(
    "bow must contact both strings evenly",
  );
  expect(await revision(page)).toBe(before);
  expect(provider.requests.filter((request) => request.tools)).toHaveLength(
    codingBefore,
  );
  await send(page, "Add a chord progression exercise.");
  await expect(
    app(page).getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible();
  await expect(
    app(page).getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
  const frame = await page.locator('iframe[data-mode="app"]').boundingBox();
  const rail = await page.locator(".conversation").boundingBox();
  expect(frame?.x).toBe(0);
  expect(frame!.width).toBeGreaterThan(1000);
  expect(rail!.width).toBeLessThanOrEqual(400);
  expect(rail!.x).toBeGreaterThan(frame!.x);
  await screenshot(page, "after-desktop-practice");
  await page
    .getByRole("button", { name: "Collapse assistant", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand assistant", exact: true }),
  ).toBeVisible();
  expect(
    (await page.locator('iframe[data-mode="app"]').boundingBox())!.width,
  ).toBeGreaterThan(frame!.width);
  await page
    .getByRole("button", { name: "Expand assistant", exact: true })
    .click();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await expect(
    app(page).getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  expect(
    provider.requests.some(
      (request) =>
        request.response_format?.json_schema?.name === "conversation",
    ),
  ).toBe(true);
  expect(
    provider.requests.some((request) =>
      request.tools?.some((tool) => tool.function.name === "check"),
    ),
  ).toBe(true);
});

test("negative feedback asks what remains wrong and a clarified failure triggers another verified repair", async ({
  page,
  context,
}) => {
  const provider = await fixture(page, context);
  // Introduce a reproducible semantic bug that render verification cannot infer.
  await page.evaluate(async () => {
    const project = await window.__itsalive.getProject();
    await window.__itsalive.edit({
      "src/App.tsx": project.files["src/App.tsx"]!.replace(
        "onClick={()=>setStarted(true)}",
        "onClick={()=>{}}",
      ),
    });
  });
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(app(page).getByRole("status")).toContainText("Choose a scale");
  await send(page, "Repair the practice exercise.");
  await expect(app(page).getByRole("status")).toContainText(
    "Choose a scale and press Start practice.",
  );
  const attempt = await revision(page);
  const requests = provider.requests.filter((request) => request.tools).length;
  await page.getByRole("button", { name: "Not yet", exact: true }).click();
  await expect(page.locator("#chat")).toContainText(
    "What's still not working as you expected?",
  );
  expect(await revision(page)).toBe(attempt);
  expect(provider.requests.filter((request) => request.tools)).toHaveLength(
    requests,
  );
  await expect(page.locator("#chat")).not.toContainText(
    "Thanks — feedback saved.",
  );
  await send(
    page,
    "The exercise doesn't respond when I click Start. Please fix it.",
  );
  await expect.poll(() => revision(page)).not.toBe(attempt);
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
  await expect(
    page.getByRole("button", { name: "Not yet", exact: true }),
  ).toBeVisible();
  expect(
    provider.requests.some(
      (request) =>
        request.tools?.some((tool) => tool.function.name === "write_file") &&
        request.reasoning?.effort === "high",
    ),
  ).toBe(true);
  const traces = await page.evaluate(() => window.__itsalive.diagnostics());
  const feedback = traces.find(
    (row) => row.event.includes("feedback") && row.revisionId === attempt,
  );
  expect(feedback).toBeDefined();
  expect(JSON.stringify(feedback)).toContain("feedbackId");
  expect(JSON.stringify(feedback)).not.toContain(
    "Repair the practice exercise",
  );
});

test("mobile switches application and companion without losing running activity; a second goal is a different useful app", async ({
  page,
  context,
}) => {
  await fixture(page, context);
  await app(page)
    .getByRole("combobox", { name: "Scale", exact: true })
    .selectOption("G major");
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  const frameURL = await page
    .locator('iframe[data-mode="app"]')
    .getAttribute("src");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "View application", exact: true })
    .click();
  await expect(
    app(page).getByRole("combobox", { name: "Scale", exact: true }),
  ).toHaveValue("G major");
  await screenshot(page, "after-mobile-application");
  await page
    .getByRole("button", { name: "View assistant", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await screenshot(page, "after-mobile-assistant");
  await page
    .getByRole("button", { name: "View application", exact: true })
    .click();
  expect(
    await page.locator('iframe[data-mode="app"]').getAttribute("src"),
  ).toBe(frameURL);
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "View assistant", exact: true })
    .click();
  await page.getByRole("button", { name: "New app", exact: true }).click();
  const dialog = page.locator("#create-dialog");
  await dialog
    .getByRole("textbox", { name: "What would you like to do?", exact: true })
    .fill("Create an interactive climbing-knot tutorial.");
  await dialog.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(
    app(page).getByRole("heading", {
      name: "Climbing knot practice",
      exact: true,
    }),
  ).toBeVisible();
  await app(page)
    .getByRole("button", { name: "Next step", exact: true })
    .click();
  await expect(
    app(page).getByRole("heading", { name: "Step 2 of 4", exact: true }),
  ).toBeVisible();
  await expect(app(page).getByText(/Pass the working end/)).toBeVisible();
});

test("settings support keyboard close, cancel, useful defaults and connection error recovery", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await openSettings(page);
  const dialog = page.locator("#settings-dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Connect with" }),
  ).toBeVisible();
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press(i < 8 ? "Tab" : "Shift+Tab");
    expect(
      await page.evaluate(() =>
        document
          .querySelector("#settings-dialog")!
          .contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await dialog
    .getByLabel("OpenAI API key", { exact: true })
    .fill("unsaved-key");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#more-options > summary")).toBeFocused();
  await openSettings(page);
  await expect(
    dialog.getByLabel("OpenAI API key", { exact: true }),
  ).toHaveValue("");
  await dialog.getByText("AI choices", { exact: true }).click();
  for (const level of ["Low", "Medium", "High", "Live voice"])
    await expect(
      dialog.getByLabel(`${level} model`, { exact: true }),
    ).toBeVisible();
  await expect(dialog.getByText("OpenRouter", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByText("Use scripted test provider", { exact: true }),
  ).toHaveCount(0);
  await dialog.getByText("Usage", { exact: true }).click();
  await expect(
    dialog.getByLabel("Enable spending limit", { exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByLabel("Monthly limit (USD)", { exact: true }),
  ).not.toBeVisible();
  await dialog.getByLabel("Enable spending limit", { exact: true }).check();
  await expect(
    dialog.getByLabel("Monthly limit (USD)", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openSettings(page);
  await dialog
    .getByLabel("OpenAI API key", { exact: true })
    .fill("acceptance-test-credential");
  provider.failNext = true;
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(/key|401|connection/i);
  await expect(page.locator("#provider-badge")).not.toContainText(
    "AI connected",
  );
  await expect(
    dialog.getByLabel("OpenAI API key", { exact: true }),
  ).toHaveValue("acceptance-test-credential");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#provider-badge")).toContainText("AI connected");
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await screenshot(page, "after-mobile-settings");
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeLessThanOrEqual(844);
  await dialog
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
});

test("diagnostics save and download without a working AI connection", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await openSettings(page);
  const dialog = page.locator("#settings-dialog");
  await dialog.getByText("Help and diagnostics", { exact: true }).click();
  await dialog.getByLabel("Debug logging", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(provider.requests).toHaveLength(0);
  await openSettings(page);
  await expect(
    dialog.getByLabel("Debug logging", { exact: true }),
  ).toBeChecked();
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Download diagnostic logs", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "itsalive-diagnostics.json",
  );
});

test("voice asks for an AI connection and never invokes browser speech recognition", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      SpeechRecognition: class {
        constructor() {
          throw new Error("Native speech must not run");
        }
      },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  await page
    .getByRole("button", { name: "Start voice conversation", exact: true })
    .click();
  await expect(page.locator("#settings-dialog")).toContainText(
    "OpenAI API key to use live voice",
  );
  expect(errors).toEqual([]);
});

test("internal observation preserves activity and suggestions require acceptance for a change", async ({
  page,
  context,
}) => {
  const provider = await fixture(page, context);
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  const frameURL = await page
    .locator('iframe[data-mode="app"]')
    .getAttribute("src");
  await page.evaluate(() => window.__itsalive.setObservation(true));
  expect(
    await page.locator('iframe[data-mode="app"]').getAttribute("src"),
  ).toBe(frameURL);
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
  const before = await revision(page);
  const codingBefore = provider.requests.filter(
    (request) => request.tools,
  ).length;
  for (let i = 0; i < 4; i++)
    await app(page)
      .getByRole("button", { name: "Start practice", exact: true })
      .click();
  await expect(page.locator("#suggestion")).toBeVisible();
  expect(await revision(page)).toBe(before);
  await send(page, "Why is this chord difficult?");
  await expect(page.locator("#chat")).toContainText(
    "bow must contact both strings evenly",
  );
  expect(provider.requests.filter((request) => request.tools)).toHaveLength(
    codingBefore,
  );
  await page
    .locator("#suggestion")
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(page.locator("#suggestion")).not.toBeVisible();
  expect(await revision(page)).toBe(before);
  // A fresh session resets the advisor's real one-minute suggestion cooldown.
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.evaluate(() => window.__itsalive.setObservation(true));
  for (let i = 0; i < 4; i++)
    await app(page)
      .getByRole("button", { name: "Start practice", exact: true })
      .click();
  await expect(page.locator("#suggestion")).toBeVisible();
  await page
    .locator("#suggestion")
    .getByRole("button", { name: "Try this", exact: true })
    .click();
  await expect.poll(() => revision(page)).not.toBe(before);
  expect(
    provider.requests.filter((request) => request.tools).length,
  ).toBeGreaterThan(codingBefore);
});

test("cancelled onboarding never runs a stale request after a later settings save", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  const goal = "Create a violin practice app.";
  await send(page, goal);
  await expect(page.locator("#settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(goal);
  expect(await page.evaluate(() => window.__itsalive.listApps())).toEqual([]);
  await connect(page);
  expect(await page.evaluate(() => window.__itsalive.listApps())).toEqual([]);
  expect(
    provider.requests.filter((request) =>
      request.tools?.some((tool) => tool.function.name === "write_file"),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    app(page).getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
});

test("destructive intent asks about its consequence and cancelling does not change the app", async ({
  page,
  context,
}) => {
  const provider = await fixture(page, context);
  const before = await revision(page);
  const coding = provider.requests.filter((request) => request.tools).length;
  await send(page, "Delete all my saved practice history.");
  await expect(page.locator("#proposal")).toContainText(
    "deletes your saved practice history",
  );
  await expect(
    page.getByRole("button", { name: "Confirm this change", exact: true }),
  ).toBeVisible();
  expect(await revision(page)).toBe(before);
  expect(provider.requests.filter((request) => request.tools)).toHaveLength(
    coding,
  );
  await page
    .locator("#proposal")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.locator("#proposal")).not.toBeVisible();
  expect(await revision(page)).toBe(before);
});

test("creation and backup dialogs close accessibly; restoring waits for an explicit destructive confirmation", async ({
  page,
  context,
}) => {
  await fixture(page, context);
  await page.getByRole("button", { name: "New app", exact: true }).click();
  const create = page.locator("#create-dialog");
  await expect(
    create.getByRole("button", { name: "Close new app", exact: true }),
  ).toBeVisible();
  await expect(
    create.getByRole("textbox", {
      name: "What would you like to do?",
      exact: true,
    }),
  ).toBeFocused();
  await create.getByRole("button", { name: "Create app", exact: true }).click();
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "New app", exact: true }),
  ).toBeFocused();
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (await window.__itsalive.exportBackup()).arrayBuffer(),
      ),
    ),
  );
  await app(page)
    .getByRole("button", { name: "Mark practice complete", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.__itsalive.getApp()).state.completed,
      ),
    )
    .toBe(1);
  await openSettings(page);
  await page.getByText("Backup and restore", { exact: true }).click();
  await page
    .getByRole("button", { name: "Back up or restore all apps", exact: true })
    .click();
  const backup = page.locator("#backup-dialog");
  await expect(
    backup.getByRole("button", {
      name: "Close backup and restore",
      exact: true,
    }),
  ).toBeVisible();
  const payload = {
    name: "verified-backup.itsalive",
    mimeType: "application/json",
    buffer: Buffer.from(bytes),
  };
  await backup.locator("#restore-file").setInputFiles(payload);
  await expect(
    backup.getByRole("heading", {
      name: "Replace your current workspace?",
      exact: true,
    }),
  ).toBeVisible();
  await backup
    .getByRole("button", { name: "Cancel restore", exact: true })
    .click();
  expect(
    (await page.evaluate(() => window.__itsalive.getApp())).state.completed,
  ).toBe(1);
  await backup.locator("#restore-file").setInputFiles(payload);
  await backup
    .getByRole("button", { name: "Restore this backup", exact: true })
    .click();
  await expect(backup.locator("#backup-status")).toContainText(/restor/i);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.__itsalive.getApp()).state.completed ?? 0,
      ),
    )
    .toBe(0);
  await backup
    .getByRole("button", { name: "Close backup and restore", exact: true })
    .click();
  await expect(backup).not.toBeVisible();
  await expect(
    app(page).getByText("Practice sessions: 0", { exact: true }),
  ).toBeVisible();
});

test("invalid saved credentials recover to setup without a scripted fallback", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await page.addInitScript(() =>
    localStorage.setItem("itsalive.credentials", "null"),
  );
  await ready(page);
  await send(page, "Create a violin practice app.");
  await expect(page.locator("#settings-dialog")).toBeVisible();
  expect(provider.requests).toHaveLength(0);
  await expect(page.locator("#provider-badge")).not.toContainText(
    /demo|scripted/i,
  );
});

test("a failed AI request updates health, preserves the working app and draft, and can be retried", async ({
  page,
  context,
}) => {
  const provider = await fixture(page, context);
  const before = await revision(page);
  provider.failNext = true;
  await send(page, "Add a chord progression exercise.");
  await expect(page.locator("#provider-badge")).toContainText(
    "AI needs attention",
  );
  await expect(page.locator("#status")).toContainText("Reconnect in Settings");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toHaveValue("Add a chord progression exercise.");
  expect(await revision(page)).toBe(before);
  await expect(
    app(page).getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(
    app(page).getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#provider-badge")).toContainText("AI connected");
});
