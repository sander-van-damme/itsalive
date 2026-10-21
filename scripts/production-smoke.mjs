import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";

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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://itsalive.localhost:4173");
  await page.getByRole("button", { name: "New app", exact: true }).click();
  await page
    .getByRole("textbox", { name: "App name", exact: true })
    .fill("Production fixture");
  await page.getByRole("button", { name: "Create app", exact: true }).click();
  const app = page.frameLocator("iframe[data-mode=app]");
  await expect(
    app.getByRole("heading", { name: "Production fixture" }),
  ).toBeVisible({ timeout: 20000 });
  await app.getByRole("button", { name: "Count: 0", exact: true }).click();
  await app.getByRole("button", { name: "Saved: 0", exact: true }).click();
  await page.getByRole("tab", { name: "Source", exact: true }).click();
  await page
    .getByLabel("Source file", { exact: true })
    .selectOption("src/App.tsx");
  const source = page.getByRole("textbox", {
    name: "Source code",
    exact: true,
  });
  await source.fill(
    (await source.inputValue()).replace(
      "Production fixture",
      "Production updated",
    ),
  );
  await page.getByRole("button", { name: "Apply source", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("Changes applied", {
    timeout: 20000,
  });
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(
    app.getByRole("heading", { name: "Production updated" }),
  ).toBeVisible();
  await expect(app.getByRole("button", { name: "Count: 1" })).toBeVisible();
  await page.reload();
  await expect(
    app.getByRole("heading", { name: "Production updated" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(app.getByRole("button", { name: "Saved: 1" })).toBeVisible();
  expect(await page.evaluate(() => "__itsalive" in window)).toBe(false);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "built assets",
        "WASM worker",
        "UUID bootstrap",
        "source hot update",
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
