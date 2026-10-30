import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createAppFromGoal,
  openSettings,
  openSettingsSection,
} from "./fixtures/shell-controls";
import {
  goalResponse,
  installGoalProvider,
  toolsFor,
  reply,
  VIOLIN_SOURCE,
  GOAL_CSS,
} from "./fixtures/goal-provider";

const app = (page: Page) => page.frameLocator('iframe[data-mode="app"]');
async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
}
async function connect(page: Page) {
  const dialog = await openSettings(page);
  await openSettingsSection(dialog, "AI connection");
  await dialog
    .getByLabel("OpenAI API key", { exact: true })
    .fill("recovery-fixture-credential");
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
}
async function created(page: Page) {
  await expect(
    app(page).getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#status")).toContainText(/ready/i);
}
const revision = (page: Page) =>
  page.evaluate(async () => (await window.__itsalive.getRevision()).id);
const writeEvents = (page: Page) =>
  page.evaluate(
    async () =>
      (await window.__itsalive.diagnostics()).filter(
        (row) =>
          row.event === "coding.tool" &&
          (row.data as any)?.name === "write_file",
      ).length,
  );
async function screenshot(page: Page, name: string) {
  await mkdir("work/screenshots/after", { recursive: true });
  await page.screenshot({
    path: `work/screenshots/after/${name}.png`,
    fullPage: true,
  });
}

test("dedicated first-run setup reuses validation, names the app and keeps safe settings responsive during creation", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await screenshot(page, "welcome-desktop");
  await page
    .getByRole("button", { name: "Create an app", exact: true })
    .click();
  const create = page.locator("#create-dialog");
  const idea = create.getByRole("textbox", {
    name: "What would you like to do?",
    exact: true,
  });
  await screenshot(page, "new-app-desktop");
  await idea.fill("I want to learn chords and scales on the violin.");
  await idea.press("Shift+Enter");
  await expect(idea).toHaveValue(/\n$/);
  await idea.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(create).toBeVisible();
  await idea.press("Enter");
  const onboarding = page.locator("#onboarding-dialog");
  await expect(onboarding).toBeVisible();
  await expect(page.locator("#settings-dialog")).not.toBeVisible();
  await expect(
    onboarding.getByRole("heading", { name: "Connect your AI" }),
  ).toBeVisible();
  await expect(
    onboarding.getByRole("slider", { name: /Monthly API spending/ }),
  ).not.toBeVisible();
  await expect(
    onboarding.getByLabel("Low model", { exact: true }),
  ).not.toBeVisible();
  await expect(
    onboarding.getByText("Backup and restore", { exact: true }),
  ).toHaveCount(0);
  await expect(
    onboarding.getByText("Help and diagnostics", { exact: true }),
  ).toHaveCount(0);
  for (let index = 0; index < 14; index++) {
    await page.keyboard.press(index < 7 ? "Tab" : "Shift+Tab");
    expect(
      await onboarding.evaluate((node) =>
        node.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await screenshot(page, "onboarding-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "onboarding-mobile");
  expect((await onboarding.boundingBox())!.height).toBeLessThanOrEqual(844);
  await onboarding
    .getByRole("button", { name: "Continue", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    onboarding.getByRole("button", { name: "Continue", exact: true }),
  ).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 900 });
  await onboarding
    .getByLabel("OpenAI API key", { exact: true })
    .fill("recovery-fixture-credential");
  const started = Date.now();
  await onboarding
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(onboarding.locator("#onboarding-settings-status")).toContainText(
    /connected/i,
  );
  const checked = provider.requests.length + provider.decisionRequests.length;
  expect(checked).toBeGreaterThan(0);
  let release!: () => void;
  provider.holdCoding = new Promise((resolve) => {
    release = resolve;
  });
  await onboarding
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    onboarding.getByRole("heading", { name: "Set your spending", exact: true }),
  ).toBeVisible();
  await expect(
    onboarding.getByRole("slider", { name: /Monthly API spending/ }),
  ).toHaveAttribute("aria-valuetext", "No limit");
  await expect(
    onboarding.getByLabel("OpenAI API key", { exact: true }),
  ).not.toBeVisible();
  await onboarding
    .getByRole("button", { name: "Start creating", exact: true })
    .click();
  await expect(onboarding).not.toBeVisible();
  await expect(page.locator("#cancel-work")).toBeVisible();
  await expect(page.locator("#app-name")).toHaveText("Violin Trainer");
  const validationRequests = () =>
    provider.requests.filter(
      (request) =>
        request.response_format?.json_schema?.name === "connection_check" ||
        request.tools?.some(
          (tool) => tool.function.name === "connection_check",
        ),
    ).length + provider.decisionRequests.length;
  expect(validationRequests()).toBe(checked);
  await screenshot(page, "creation-desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator("#status")
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  const beforeSettings = provider.requests.length;
  const general = await openSettings(page);
  await general.getByText("Help and diagnostics", { exact: true }).click();
  await general.getByLabel("Debug logging", { exact: true }).check();
  const saveStarted = Date.now();
  await general
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(general).not.toBeVisible({ timeout: 3000 });
  const settingsSaveMs = Date.now() - saveStarted;
  expect(provider.requests).toHaveLength(beforeSettings);
  await send(page, "Why is this chord difficult?");
  await expect(page.locator("#chat")).toContainText(
    "bow must contact both strings evenly",
  );
  expect(validationRequests()).toBe(checked);
  release();
  provider.holdCoding = undefined;
  await created(page);
  await expect(page.locator("#provider-badge")).not.toBeVisible();
  await screenshot(page, "completed-desktop");
  await page.locator("#more-options > summary").click();
  await screenshot(page, "menu-desktop");
  await page
    .locator("#more-options")
    .getByRole("button", { name: "Version history", exact: true })
    .click();
  await expect(page.locator("#revision-list .revision-row")).toHaveCount(2);
  await screenshot(page, "history-desktop");
  await writeFile(
    "work/after-metrics.json",
    JSON.stringify(
      {
        fixture:
          "deterministic HTTP goal-provider, real Chromium/compiler/UUID runtime; includes deliberate held request, settings and conversation",
        checkConnectionRequests: checked,
        repeatedValidationRequests: validationRequests() - checked,
        totalRequests:
          provider.requests.length + provider.decisionRequests.length,
        connectionAndCreationWithInteractionsMs: Date.now() - started,
        independentSettingsSaveMs: settingsSaveMs,
      },
      null,
      2,
    ),
  );
});

test("an incomplete response preserves completed writes and resumes through verified commit without replay", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  let injected = false;
  provider.intercept = async (request, route) => {
    if (
      injected ||
      !request.tools?.some((tool) => tool.function.name === "write_file")
    )
      return false;
    const response = goalResponse(request) as any;
    if (!response.output.some((item: any) => item.name === "write_file"))
      return false;
    injected = true;
    for (const item of response.output) item.status = "completed";
    response.status = "incomplete";
    response.incomplete_details = { reason: "max_output_tokens" };
    response.output.push({
      type: "function_call",
      status: "incomplete",
      call_id: "unfinished-json",
      name: "patch_file",
      arguments: '{"path":',
    });
    await route.fulfill({ status: 200, json: response });
    return true;
  };
  await createAppFromGoal(page, "Create a violin practice app.");
  await created(page);
  expect(injected).toBe(true);
  expect(await writeEvents(page)).toBe(2);
  const events = await page.evaluate(() => window.__itsalive.diagnostics());
  expect(events.some((row) => row.event === "coding.recovery")).toBe(true);
  expect(
    events.some(
      (row) =>
        row.event === "coding.check" &&
        (row.data as any)?.compiled === true &&
        (row.data as any)?.verified === true,
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("recovery-fixture-credential");
  await app(page)
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(app(page).getByRole("status")).toContainText(
    "Play each note slowly",
  );
});

test("transport failure preserves the working revision and a reload retry resumes durable candidate work", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  await createAppFromGoal(page, "Create a violin practice app.");
  await created(page);
  await app(page)
    .getByRole("button", { name: "Mark practice complete", exact: true })
    .click();
  const before = await revision(page);
  let interrupted = false;
  provider.intercept = async (request, route) => {
    if (
      !interrupted &&
      request.tools &&
      toolsFor(request).some((result) => result.name === "write_file")
    ) {
      interrupted = true;
      await route.abort("connectionreset");
      return true;
    }
    return false;
  };
  await send(page, "Add a chord progression exercise.");
  await expect(page.locator("#retry-work")).toBeVisible();
  expect(await revision(page)).toBe(before);
  const writes = await writeEvents(page);
  await expect(
    app(page).getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  const statusBounds = await page.locator("#status").boundingBox();
  const composerBounds = await page.locator("#chat-form").boundingBox();
  expect(statusBounds!.y + statusBounds!.height).toBeLessThanOrEqual(
    composerBounds!.y,
  );
  await screenshot(page, "failure-desktop");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await expect(page.locator("#retry-work")).toBeVisible();
  await page.locator("#retry-work").click();
  await expect(
    app(page).getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#status")).toContainText(/ready/i);
  expect(await revision(page)).not.toBe(before);
  expect(await writeEvents(page)).toBe(writes);
  await expect(
    app(page).getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
});

test("cancelling a request leaves a reusable checkpoint and preserves an explicit app name", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  provider.intercept = async (request, route) => {
    if (
      !holding &&
      request.tools &&
      toolsFor(request).some((result) => result.name === "write_file")
    ) {
      holding = true;
      await held;
      await route
        .fulfill({ status: 200, json: goalResponse(request) })
        .catch(() => {});
      return true;
    }
    return false;
  };
  await page.locator("#welcome-create").click();
  const dialog = page.locator("#create-dialog");
  await dialog
    .getByLabel("What would you like to do?", { exact: true })
    .fill("Create a violin practice app.");
  await dialog
    .getByLabel("App name", { exact: true })
    .fill("My Bowing Journal");
  await dialog.getByRole("button", { name: "Create app", exact: true }).click();
  await expect.poll(() => holding).toBe(true);
  const before = await revision(page);
  await page.locator("#cancel-work").click();
  await expect(page.locator("#retry-work")).toBeVisible();
  expect(await revision(page)).toBe(before);
  expect(await writeEvents(page)).toBe(2);
  release();
  await page.locator("#retry-work").click();
  await created(page);
  await expect(page.locator("#app-name")).toHaveText("My Bowing Journal");
  expect(await writeEvents(page)).toBe(2);
});

test("check execution success is distinct from failed compilation and a repaired candidate is verified before commit", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  let phase = 0;
  provider.intercept = async (request, route) => {
    if (!request.tools?.some((tool) => tool.function.name === "write_file"))
      return false;
    let response;
    if (phase++ === 0)
      response = reply("", [
        {
          name: "write_file",
          args: {
            path: "src/App.tsx",
            content: "export default function App(){return <main>broken",
          },
        },
        { name: "check", args: {} },
      ]);
    else if (phase === 2) {
      expect(
        toolsFor(request).some(
          (result) => result.name === "check" && result.value.ok === false,
        ),
      ).toBe(true);
      response = reply("", [
        {
          name: "write_file",
          args: { path: "src/App.tsx", content: VIOLIN_SOURCE },
        },
        {
          name: "write_file",
          args: { path: "src/styles.css", content: GOAL_CSS },
        },
        { name: "check", args: {} },
      ]);
    } else
      response = reply("", [
        { name: "finish", args: { summary: "Ready to try." } },
      ]);
    await route.fulfill({ status: 200, json: response });
    return true;
  };
  await createAppFromGoal(page, "Create a violin practice app.");
  await created(page);
  const events = await page.evaluate(() => window.__itsalive.diagnostics());
  const checks = events
    .filter((row) => row.event === "coding.check")
    .map((row) => row.data as any);
  expect(checks[0]).toMatchObject({ compiled: false, verified: false });
  expect(checks[0].diagnosticCount).toBeGreaterThan(0);
  expect(checks.at(-1)).toMatchObject({
    compiled: true,
    verified: true,
    diagnosticCount: 0,
  });
  expect(
    events
      .filter(
        (row) =>
          row.event === "coding.tool" && (row.data as any)?.name === "check",
      )
      .every((row) => (row.data as any).ok === true),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("<main>broken");
});

test("switching away from an app aborts its pending AI request and records unknown failed usage", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await ready(page);
  await connect(page);
  await page.evaluate(async () => {
    await window.__itsalive.createApp("First application");
    await window.__itsalive.edit({
      "src/App.tsx": `import React,{useState} from 'react';import {text} from '@itsalive/ai';export default function App(){const [result,setResult]=useState('Ready');return <main><button onClick={()=>{setResult('Waiting');text('frame-owned pending request').then(setResult).catch(()=>setResult('Stopped'))}}>Ask AI</button><p role="status">{result}</p></main>}`,
    });
  });
  let started = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.intercept = async (request, route) => {
    if (
      request.messages.some(
        (message) => message.content === "frame-owned pending request",
      )
    ) {
      started = true;
      await held;
      await route
        .fulfill({ status: 200, json: reply("Late result") })
        .catch(() => {});
      return true;
    }
    return false;
  };
  await app(page).getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => window.__itsalive.createApp("Second application"));
  await expect(page.locator("#app-name")).toHaveText("Second application");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const names = await indexedDB.databases();
        const name = names.find((item) => item.name === "itsalive-v2")?.name;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(name!);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          return await new Promise<any>((resolve, reject) => {
            const request = db
              .transaction("settings")
              .objectStore("settings")
              .get("ai.usage");
            request.onsuccess = () =>
              resolve(
                request.result?.value
                  ?.filter((row: any) => row.role === "application")
                  .at(-1),
              );
            request.onerror = () => reject(request.error);
          });
        } finally {
          db.close();
        }
      }),
    )
    .toMatchObject({
      status: "failed",
      usageStatus: "unknown",
      costStatus: "unknown",
    });
  release();
  await expect(app(page).getByText("Late result", { exact: true })).toHaveCount(
    0,
  );
});
