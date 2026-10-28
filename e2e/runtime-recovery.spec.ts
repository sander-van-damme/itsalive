import { test, expect, type Page } from "@playwright/test";
import type { WorkActivity, WorkActivityResult } from "../src/shared/types";

type ReviewAPI = Window["__itsalive"] & {
  setActivity(activity: WorkActivity): Promise<WorkActivityResult>;
  clearActivity(): Promise<void>;
};

const SOURCE = `import React, { useState } from 'react';
import './styles.css';
export default function App(){
 const [count,setCount]=useState(0); const [outside,setOutside]=useState(0);
 const [initialWidth]=useState(()=>document.documentElement.clientWidth);
 return <main><output data-testid="initial-width">{initialWidth}</output><section aria-label="Practice"><h1>Practice</h1><button onClick={()=>setCount(count+1)}>Exercise: {count}</button></section><section aria-label="Other activity"><h2>Other activity</h2><button onClick={()=>setOutside(outside+1)}>Other: {outside}</button></section></main>
}`;

async function prepare(page: Page) {
  await page.goto("/?test-provider=scripted");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.evaluate(() => window.__itsalive.createApp("Practice"));
  await page.evaluate(
    async (source) =>
      window.__itsalive.edit({
        "src/App.tsx": source,
        "src/styles.css":
          "body{margin:0;font:18px system-ui;background:#fff;color:#172632}main{padding:32px;display:grid;gap:24px}section{border:1px solid #8798a8;border-radius:12px;padding:24px}button{font:inherit;padding:12px}",
      }),
    SOURCE,
  );
  await expect(
    page
      .frameLocator('iframe[data-mode="app"]')
      .getByRole("heading", { name: "Practice", exact: true }),
  ).toBeVisible();
}

test("switching apps retains the mounted practice session and its transient state", async ({
  page,
}) => {
  await prepare(page);
  const firstId = await page.evaluate(
    async () => (await window.__itsalive.getApp()).id,
  );
  const original = await (await page
    .locator('iframe[data-mode="app"]')
    .elementHandle())!.contentFrame();
  await original!
    .getByRole("button", { name: "Exercise: 0", exact: true })
    .click();
  await original!
    .getByRole("button", { name: "Exercise: 1", exact: true })
    .click();
  const originalRegion = await page.evaluate(
    async () =>
      (await window.__itsalive.inspect()).regions!.find(
        (region) => region.label === "Practice" && region.role === "section",
      )!.id,
  );
  await page.evaluate(() => window.__itsalive.createApp("Second app"));
  await page.evaluate(
    (source) => window.__itsalive.edit({ "src/App.tsx": source }),
    SOURCE,
  );
  await page.evaluate(() => window.__itsalive.inspect());
  const foreignMarker = await page.evaluate(
    (id) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Updating practice.",
        targets: [id],
      }),
    originalRegion,
  );
  expect(foreignMarker).toEqual({ resolved: [], rejected: [originalRegion] });
  await expect(page.locator('iframe[data-mode="parked"]')).toHaveCount(1);
  await page.evaluate((id) => window.__itsalive.openApp(id), firstId);
  await expect(page.locator('iframe[data-mode="app"]')).toHaveCount(1);
  await expect(
    original!.getByRole("button", { name: "Exercise: 2", exact: true }),
  ).toBeVisible();
  expect(original!.isDetached()).toBe(false);
});

test("restored apps have a real viewport for their initial layout measurements", async ({
  page,
}) => {
  await prepare(page);
  await page.reload();
  const output = page
    .frameLocator('iframe[data-mode="app"]')
    .getByTestId("initial-width");
  await expect(output).toBeVisible();
  expect(Number(await output.textContent())).toBeGreaterThan(100);
});

test("a candidate that passes cold verification but fails live preserves the working app and exact failure", async ({
  page,
}) => {
  await prepare(page);
  const handle = await page.locator('iframe[data-mode="app"]').elementHandle();
  const frame = (await handle!.contentFrame())!;
  await frame.getByRole("button", { name: "Exercise: 0", exact: true }).click();
  await frame.evaluate(() => {
    (
      window as Window & { __liveFailureFixture?: boolean }
    ).__liveFailureFixture = true;
  });
  const before = await page.evaluate(
    async () => (await window.__itsalive.getApp()).currentRevision,
  );
  const outcome = await page.evaluate(async (source) => {
    try {
      await window.__itsalive.edit({ "src/App.tsx": source });
      return { ok: true };
    } catch (error) {
      const failure = error as Error & { detail: Record<string, unknown> };
      return {
        ok: false,
        name: failure.name,
        message: failure.message,
        detail: failure.detail,
      };
    }
  }, `if ((globalThis as unknown as { __liveFailureFixture?: boolean }).__liveFailureFixture) throw new TypeError('Live-only fixture failure');\n${SOURCE}`);
  expect(outcome).toMatchObject({
    ok: false,
    name: "LiveApplicationError",
    message: "Live-only fixture failure",
    detail: {
      stage: "live-apply",
      rollbackSucceeded: true,
      baseRevisionId: before,
    },
  });
  expect(
    await page.evaluate(
      async () => (await window.__itsalive.getApp()).currentRevision,
    ),
  ).toBe(before);
  await expect(
    frame.getByRole("button", { name: "Exercise: 1", exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => window.__itsalive.inspect())).errors,
  ).toEqual([]);
});

test("work markers resolve real regions, leave unrelated controls usable and clear completely", async ({
  page,
}) => {
  await prepare(page);
  const inspection = await page.evaluate(() => window.__itsalive.inspect());
  const region = inspection.regions!.find(
    (candidate) =>
      candidate.label === "Practice" && candidate.role === "section",
  )!;
  expect(region).toBeTruthy();
  const result = await page.evaluate(
    async ({ id }) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Updating the practice exercises.",
        targets: [id, "invented-target"],
      }),
    { id: region.id },
  );
  expect(result).toEqual({
    resolved: [region.id],
    rejected: ["invented-target"],
  });
  const frame = page.frameLocator('iframe[data-mode="app"]');
  const target = frame.locator('section[aria-label="Practice"]');
  await expect(target).toHaveAttribute("aria-busy", "true");
  await expect(target).toHaveAttribute("inert", "");
  const marker = frame.locator(`[data-itsalive-activity="${region.id}"]`);
  await expect(marker).toBeVisible();
  const targetBox = await target.boundingBox(),
    markerBox = await marker.boundingBox();
  expect(Math.abs(targetBox!.x - markerBox!.x)).toBeLessThan(1);
  expect(Math.abs(targetBox!.width - markerBox!.width)).toBeLessThan(1);
  await frame.getByRole("button", { name: "Other: 0", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Other: 1", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("precise-work-marker.png"),
  });
  await page.evaluate(() => (window.__itsalive as ReviewAPI).clearActivity());
  await expect(marker).toHaveCount(0);
  await expect(target).not.toHaveAttribute("inert", "");
  await expect(target).not.toHaveAttribute("aria-busy", "true");
  await frame.getByRole("button", { name: "Exercise: 0", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Exercise: 1", exact: true }),
  ).toBeVisible();
});

test("reduced-motion work markers are static and revision changes expire previous region IDs", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page);
  const inspection = await page.evaluate(() => window.__itsalive.inspect());
  const id = inspection.regions!.find(
    (region) => region.label === "Practice",
  )!.id;
  await page.evaluate(
    (id) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Updating practice.",
        targets: [id],
      }),
    id,
  );
  const handle = await page.locator('iframe[data-mode="app"]').elementHandle();
  const frame = (await handle!.contentFrame())!;
  expect(
    await frame.evaluate(
      () =>
        document
          .querySelector("[data-itsalive-activity-host]")!
          .getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  await page.evaluate(async () =>
    window.__itsalive.edit({
      "src/updated.css": "section { border-color: #537180; }",
    }),
  );
  await expect(frame.locator("[data-itsalive-activity-host]")).toHaveCount(0);
  const result = await page.evaluate(
    (id) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Checking practice.",
        targets: [id],
      }),
    id,
  );
  expect(result.resolved).toEqual([]);
  expect(result.rejected).toEqual([id]);
  await expect(frame.locator("[data-itsalive-activity-host]")).toHaveCount(0);
});

test("work markers respect scroll clipping and native dialog top layers", async ({
  page,
}) => {
  await prepare(page);
  const handle = await page.locator('iframe[data-mode="app"]').elementHandle();
  const frame = (await handle!.contentFrame())!;
  await frame.evaluate(() => {
    const practice = document.querySelector<HTMLElement>(
      'section[aria-label="Practice"]',
    )!;
    const clip = document.createElement("div");
    clip.id = "scroll-container";
    clip.style.cssText = "height:80px;overflow:auto;position:relative";
    practice.before(clip);
    clip.append(practice);
    practice.style.height = "300px";
  });
  let inspection = await page.evaluate(() => window.__itsalive.inspect());
  const practice = inspection.regions!.find(
    (region) => region.label === "Practice" && region.role === "section",
  )!;
  await page.evaluate(
    (id) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Updating practice.",
        targets: [id],
      }),
    practice.id,
  );
  const clipBox = await frame.locator("#scroll-container").boundingBox();
  const markerBox = await frame
    .locator(`[data-itsalive-activity="${practice.id}"]`)
    .boundingBox();
  expect(markerBox!.height).toBeLessThanOrEqual(clipBox!.height);
  expect(markerBox!.y + markerBox!.height).toBeLessThanOrEqual(
    clipBox!.y + clipBox!.height,
  );
  await frame.getByRole("button", { name: "Other: 0", exact: true }).click();
  await page.evaluate(() => (window.__itsalive as ReviewAPI).clearActivity());
  await frame.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Practice options");
    dialog.innerHTML =
      '<section aria-label="Tempo"><h2>Tempo</h2><button>Set tempo</button></section><button id="close-options">Close options</button>';
    document.querySelector("main")!.append(dialog);
    dialog.querySelector("#close-options")!.addEventListener("click", () => {
      dialog.close();
    });
    dialog.showModal();
  });
  inspection = await page.evaluate(() => window.__itsalive.inspect());
  const tempo = inspection.regions!.find(
    (region) => region.label === "Tempo" && region.role === "section",
  )!;
  await page.evaluate(
    (id) =>
      (window.__itsalive as ReviewAPI).setActivity({
        message: "Updating the tempo control.",
        targets: [id],
      }),
    tempo.id,
  );
  await expect(
    frame.locator(`dialog > [data-itsalive-activity="${tempo.id}"]`),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Close options" }).click();
  await page.evaluate(() => (window.__itsalive as ReviewAPI).clearActivity());
  await expect(frame.locator("[data-itsalive-activity]")).toHaveCount(0);
  await expect(frame.locator('[aria-label="Tempo"]')).not.toHaveAttribute(
    "inert",
    "",
  );
});
