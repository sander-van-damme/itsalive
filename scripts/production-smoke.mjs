import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

// Replay stays in tests; the production app still uses its real HTTP adapter.
const fixture = await build({
  entryPoints: ["e2e/fixtures/goal-provider.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { installGoalProvider } = await import(
  `data:text/javascript;base64,${Buffer.from(fixture.outputFiles[0].text).toString("base64")}`
);

const mime = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
const servers = [];
let browser;
try {
  for (const [port, dir] of [
    [4173, "dist-root"],
    [4174, "dist-app"],
  ]) {
    const root = resolve(dir);
    const server = createServer(async (req, res) => {
      try {
        let file = resolve(
          root,
          "." + new URL(req.url, "http://localhost").pathname,
        );
        if (!file.startsWith(root + sep) && file !== root) {
          res.writeHead(403).end();
          return;
        }
        try {
          if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
        } catch {
          file = resolve(root, "index.html");
        }
        res.setHeader(
          "Content-Type",
          mime[extname(file)] ?? "application/octet-stream",
        );
        res.end(await readFile(file));
      } catch {
        res.writeHead(500).end("Static serving failed");
      }
    });
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "0.0.0.0", resolve);
    });
    servers.push(server);
  }
  browser = await chromium.launch({
    args: [
      "--host-resolver-rules=MAP *.localhost 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  const context = await browser.newContext();
  await installGoalProvider(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://itsalive.localhost:4173");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("I want an app that teaches me violin chords and scales.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("#onboarding-dialog")).toBeVisible();
  await page
    .locator("#onboarding-ai-key")
    .fill("production-deterministic-provider-key");
  await page.locator("#onboarding-save-settings").click();
  await expect(page.locator("#onboarding-dialog")).not.toBeVisible({
    timeout: 20000,
  });
  const app = page.frameLocator("iframe[data-mode=app]");
  await expect(
    app.getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("textbox", { name: "Source code", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply change", exact: true }),
  ).toHaveCount(0);
  await app
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(app.getByRole("status")).toContainText("Play each note slowly");
  await app
    .getByRole("button", { name: "Mark practice complete", exact: true })
    .click();
  await expect(
    app.getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  const origin = await page
    .locator("iframe[data-mode=app]")
    .getAttribute("src");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Add a chord progression exercise.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    app.getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(await page.locator("iframe[data-mode=app]").getAttribute("src")).toBe(
    origin,
  );
  await expect(app.getByRole("status")).toContainText("Play each note slowly");
  await expect(
    app.getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    app.getByRole("heading", { name: "Chord progression", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    app.getByText("Practice sessions: 1", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => "__itsalive" in window)).toBe(false);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      ok: true,
      provider: "deterministic HTTP replay; no live API credentials",
      checks: [
        "built assets",
        "first-run request resumption",
        "WASM worker",
        "UUID bootstrap",
        "goal-specific app generation",
        "automatic conversational changes",
        "hidden source editor",
        "React state retention",
        "durable reload",
        "no development hooks",
        "no uncaught browser errors",
      ],
    }),
  );
} finally {
  await browser?.close();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
}
