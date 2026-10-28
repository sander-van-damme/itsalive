import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createAppFromGoal } from "./fixtures/shell-controls";

// No recording may capture the API-key entry or provider request headers.
test.use({ trace: "off", screenshot: "off", video: "off" });
test("real OpenAI creates, verifies, commits and updates a usable violin trainer", async ({
  page,
}) => {
  test.skip(
    process.env.ITSALIVE_LIVE !== "1",
    "Explicit --live opt-in required; this test incurs real provider charges.",
  );
  test.setTimeout(Number(process.env.ITSALIVE_LIVE_TIMEOUT_MS) || 15 * 60_000);
  const credential = process.env.OPENAI_API_KEY;
  if (!credential)
    throw new Error(
      "OPENAI_API_KEY is unavailable; no live validation performed.",
    );
  const started = Date.now();
  const timings: Record<string, number> = {};
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("Uncaught browser exception"));
  try {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__itsalive));
    await createAppFromGoal(
      page,
      "Create a small violin practice app titled Violin Trainer. Show the D-major scale notes and a short open D/A double-stop exercise. Include a button named Complete practice and a visible counter formatted Completed sessions: 0. Each click increments the counter using durable storage. This is a visual practice guide, with no microphone or pitch detection. Keep it simple and functional.",
    );
    const onboarding = page.locator("#onboarding-dialog");
    await expect(onboarding).toBeVisible();
    const keyInput = onboarding.getByLabel("OpenAI API key", { exact: true });
    await expect(keyInput).toBeVisible();
    // Evaluate does not include the credential in locator action call logs.
    await keyInput.evaluate((input, value) => {
      (input as HTMLInputElement).value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, credential);
    const connectionStarted = Date.now();
    await onboarding
      .getByRole("button", { name: "Check connection", exact: true })
      .click();
    await expect(
      onboarding.locator("#onboarding-settings-status"),
    ).toContainText(/checked|connected/i, { timeout: 240_000 });
    timings.connectionMs = Date.now() - connectionStarted;
    const creationStarted = Date.now();
    await onboarding
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    const spending = onboarding.getByRole("slider", {
      name: /Monthly API spending/,
    });
    await expect(spending).toBeVisible();
    if (process.env.ITSALIVE_LIVE_BUDGET) {
      await spending.focus();
      await spending.press("Home");
      await onboarding
        .getByLabel("Exact monthly limit (USD)", { exact: true })
        .fill(process.env.ITSALIVE_LIVE_BUDGET);
    }
    await onboarding
      .getByRole("button", { name: "Start creating", exact: true })
      .click();
    await expect(onboarding).not.toBeVisible({ timeout: 30_000 });
    const app = page.frameLocator('iframe[data-mode="app"]');
    await expect(
      app.getByRole("heading", { name: "Violin Trainer", exact: true }),
    ).toBeVisible({ timeout: 600_000 });
    await expect(page.locator("#status")).toContainText(/ready/i, {
      timeout: 60_000,
    });
    timings.creationMs = Date.now() - creationStarted;
    const firstRevision = await page.evaluate(() =>
      window.__itsalive.getRevision(),
    );
    expect(firstRevision.parent).not.toBeNull();
    await app
      .getByRole("button", { name: "Complete practice", exact: true })
      .click();
    await expect(
      app.getByText("Completed sessions: 1", { exact: true }),
    ).toBeVisible();
    const updateStarted = Date.now();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(
        "Add a button named Reset practice that resets Completed sessions to 0. Keep the current completed count until I click it, and preserve the violin exercises and Complete practice button.",
      );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.getByRole("button", { name: "Reset practice", exact: true }),
    ).toBeVisible({ timeout: 600_000 });
    await expect(page.locator("#status")).toContainText(/ready/i, {
      timeout: 60_000,
    });
    timings.updateMs = Date.now() - updateStarted;
    expect(
      (await page.evaluate(() => window.__itsalive.getRevision())).id,
    ).not.toBe(firstRevision.id);
    await expect(
      app.getByText("Completed sessions: 1", { exact: true }),
    ).toBeVisible();
    await app
      .getByRole("button", { name: "Reset practice", exact: true })
      .click();
    await expect(
      app.getByText("Completed sessions: 0", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      app.getByText("Completed sessions: 0", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    const records = await page.evaluate(async () => {
      const names = await indexedDB.databases();
      const name = names.find((item) => item.name === "itsalive-v2")?.name;
      if (!name) throw new Error("Usage database unavailable");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        const request = db
          .transaction("settings")
          .objectStore("settings")
          .get("ai.usage");
        return await new Promise<any[]>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result?.value ?? []);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    });
    const diagnostics = await page.evaluate(() =>
      window.__itsalive.diagnostics(),
    );
    const report = {
      provider: "real OpenAI",
      ok: true,
      timings: { ...timings, totalMs: Date.now() - started },
      requests: records.map((row) => ({
        role: row.role,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        costUSD: row.costUSD,
        usageStatus: row.usageStatus,
        costStatus: row.costStatus,
        latencyMs: row.latencyMs,
        status: row.status,
      })),
      stages: diagnostics
        .filter((row) =>
          /coding\.(check|stage|complete)|revision.applied|candidate.verified/.test(
            row.event,
          ),
        )
        .map((row) => ({ event: row.event, data: row.data })),
      checks: [
        "real connection",
        "natural-language generation",
        "candidate compilation and verification",
        "committed revision",
        "working practice counter",
        "requested feature update",
        "retained state",
        "reload",
      ],
    };
    await mkdir("work", { recursive: true });
    await writeFile(
      "work/live-provider-results.json",
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        ok: true,
        provider: report.provider,
        timings: report.timings,
        requests: records.length,
        report: "work/live-provider-results.json",
      }),
    );
  } finally {
    await page.close();
  }
});
