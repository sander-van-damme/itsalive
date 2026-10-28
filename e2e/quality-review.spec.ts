import { expect, test, type Page } from "@playwright/test";
import type { RuntimeQualityInspection } from "../src/runtime/quality";
import { installGoalProvider, reply } from "./fixtures/goal-provider";
import { createAppFromGoal } from "./fixtures/shell-controls";

async function audit(
  page: Page,
  content: string,
): Promise<RuntimeQualityInspection> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.setContent(
    `<style>body{font:16px system-ui;background:#fff;color:#111}button,input{font:inherit}dialog{background:#fff;color:#111}</style><main id="fixture">${content}</main>`,
  );
  return page.evaluate(async (path) => {
    const { inspectQuality } = await import(path);
    return inspectQuality(document.getElementById("fixture")!);
  }, `/@fs${process.cwd()}/src/runtime/quality.ts`);
}

test("readable named controls pass and small secondary copy stays advisory", async ({
  page,
}) => {
  const result = await audit(
    page,
    `<h1>Practice</h1><p>Play four notes, then release your thumb.</p><label for="tempo">Tempo</label><input id="tempo" value="60"><button><span>Start practice</span></button><button><svg viewBox="0 0 20 20" width="20" height="20"><title>Play sound</title><path d="M5 5L15 10L5 15Z"/></svg></button><small style="font-size:12px;color:#444">Last session: today</small><dialog open aria-labelledby="dialog-title"><h2 id="dialog-title">Practice settings</h2><button>Close</button></dialog>`,
  );
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual(
    [],
  );
  expect(
    result.issues.some(
      (issue) => issue.code === "small-text" && issue.severity === "warning",
    ),
  ).toBe(true);
  expect(result.checkedControls).toBe(4);
  expect(result.checkedTextElements).toBeGreaterThan(3);
});

test("actual low contrast and unnamed interactive controls produce actionable errors", async ({
  page,
}) => {
  const result = await audit(
    page,
    `<p id="low" style="color:#aaa">Read this instruction.</p><button id="unnamed" style="width:44px;height:44px"><svg aria-hidden="true" width="20" height="20"><path d="M5 5L15 10L5 15Z"/></svg></button><input id="unlabelled"><dialog open><p>Settings</p></dialog>`,
  );
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "text-contrast",
        severity: "error",
        element: "p#low",
        actual: 2.323,
        expected: 4.5,
      }),
      expect.objectContaining({
        code: "control-name",
        severity: "error",
        element: "button#unnamed",
      }),
      expect.objectContaining({
        code: "control-name",
        severity: "error",
        element: "input#unlabelled",
      }),
      expect.objectContaining({ code: "dialog-name", severity: "error" }),
    ]),
  );
});

test("gradients and opacity remain inconclusive while hidden and inactive content is excluded", async ({
  page,
}) => {
  const result = await audit(
    page,
    `<p id="gradient" style="background:linear-gradient(#000,#fff);color:#aaa">A gradient needs inspection.</p><p id="opacity" style="opacity:.5;color:#aaa">Transparent text needs inspection.</p><p hidden style="color:#fff">Hidden text</p><button disabled style="color:#fff;background:#fff">Unavailable</button><dialog><button></button></dialog>`,
  );
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual(
    [],
  );
  expect(result.inconclusive).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        element: "p#gradient",
        reason: expect.stringContaining("gradient"),
      }),
      expect.objectContaining({
        element: "p#opacity",
        reason: expect.stringContaining("Opacity"),
      }),
    ]),
  );
  expect(result.checkedControls).toBe(0);
  expect(result.checkedTextElements).toBe(2);
});

test("large text uses its actual size threshold and transparent solid layers are composited", async ({
  page,
}) => {
  const result = await audit(
    page,
    `<h1 id="large" style="font-size:24px;font-weight:400;color:#888">Large heading</h1><p id="normal" style="font-size:16px;color:#888">Normal text</p><section style="background:#000"><p id="layered" style="background:rgba(255,255,255,.5);color:#777">Transparent panel text</p></section>`,
  );
  expect(
    result.issues.some(
      (issue) => issue.element === "h1#large" && issue.severity === "error",
    ),
  ).toBe(false);
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        element: "p#normal",
        code: "text-contrast",
        expected: 4.5,
      }),
      expect.objectContaining({
        element: "p#layered",
        code: "text-contrast",
        severity: "error",
      }),
    ]),
  );
});

test("independent painted layers and generated labels remain inconclusive", async ({
  page,
}) => {
  const result = await audit(
    page,
    `<section style="position:relative"><div style="position:absolute;inset:0;background:#000"></div><p id="overlap" style="position:relative;color:#fff">White text on a separate black layer.</p></section><style>#generated::before{content:'Play'}</style><button id="generated"></button><button><span aria-labelledby="external"></span></button><span id="external">Pause</span>`,
  );
  expect(result.issues.filter((issue) => issue.severity === "error")).toEqual(
    [],
  );
  expect(result.inconclusive).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        element: "p#overlap",
        reason: expect.stringContaining("Overlapping"),
      }),
      expect.objectContaining({
        element: "button#generated",
        reason: expect.stringContaining("accessible name"),
      }),
    ]),
  );
});

test("rendered candidate contrast reaches the worker and is repaired before the app is published", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  let attempts = 0;
  let receivedEvidence = false;
  provider.intercept = async (request, route) => {
    if (!request.tools?.some((tool) => tool.function.name === "write_file"))
      return false;
    attempts++;
    receivedEvidence ||= request.messages.some((message) =>
      message.content.includes('"code":"text-contrast"'),
    );
    const color = receivedEvidence ? "#222" : "#aaa";
    await route.fulfill({
      status: 200,
      json: reply("", [
        {
          name: "write_file",
          args: {
            path: "src/App.tsx",
            content:
              "import React from 'react';import './styles.css';export default function App(){return <main><h1>Practice</h1><p id='instruction'>Release your thumb between notes.</p><button>Start practice</button></main>}",
          },
        },
        {
          name: "write_file",
          args: {
            path: "src/styles.css",
            content: `:root{font-family:system-ui;color:#111;background:#fff}body{margin:0}main{padding:32px}h1{font-size:28px}p{font-size:16px;color:${color}}button{font:inherit;color:#111;background:#fff;padding:12px}`,
          },
        },
        {
          name: "finish",
          args: { summary: "Your practice instructions are ready." },
        },
      ]),
    });
    return true;
  };
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await createAppFromGoal(page, "Create a violin practice app.");
  await page.locator("#onboarding-ai-key").fill("quality-fixture-key");
  await page.locator("#onboarding-save-settings").click();
  await expect(page.locator("#onboarding-save-settings")).toHaveText(
    "Start creating",
  );
  await page.locator("#onboarding-save-settings").click();
  const app = page.frameLocator('iframe[data-mode="app"]');
  await expect(
    app.getByRole("heading", { name: "Practice", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#status")).toContainText("Ready to try");
  expect(receivedEvidence).toBe(true);
  expect(attempts).toBe(2);
  await expect(app.locator("#instruction")).toHaveCSS(
    "color",
    "rgb(34, 34, 34)",
  );
  const inspected = await page.evaluate(() => window.__itsalive.inspect());
  expect(
    inspected.quality?.issues.filter((issue) => issue.severity === "error"),
  ).toEqual([]);
});
