import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

// Optional network compatibility check. The normal acceptance suite uses replayed package bytes.
test("downloads a real pinned npm package and reuses it across isolated app origins", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.ITSALIVE_LIVE_PACKAGES !== "1",
    "Enable ITSALIVE_LIVE_PACKAGES=1 for the external gateway check",
  );
  test.setTimeout(120_000);
  // The cloud browser's local development origins must remain direct. Forward only
  // external gateway traffic through curl's configured session proxy/CA trust.
  // These are fresh network responses, not recorded fixtures or generated package code.
  const responses: { url: string; bytes: number }[] = [];
  await context.route("https://esm.sh/**", async (route) => {
    try {
      const { stdout } = await promisify(execFile)(
        "curl",
        [
          "--max-time",
          "25",
          "--fail",
          "--silent",
          "--show-error",
          route.request().url(),
        ],
        { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
      );
      responses.push({ url: route.request().url(), bytes: stdout.byteLength });
      await route.fulfill({
        status: 200,
        body: stdout,
        contentType: "application/javascript",
        headers: { "access-control-allow-origin": "*" },
      });
    } catch {
      await route.abort("failed");
    }
  });
  try {
    const navigation = await page.goto("http://itsalive.localhost:4173");
    expect(navigation?.status()).toBe(200);
    expect(await page.title()).toContain("Alive");
    const result = await page.evaluate(async (root) => {
      const { BrowserCompiler } = await import(`${root}/src/compiler/index.ts`);
      const { FrameSession } = await import(`${root}/src/shell/frame.ts`);
      await caches.delete("itsalive-dependencies-v2");
      const project = {
        entry: "src/App.tsx",
        dependencies: { nanoid: "5.1.6" },
        lock: {},
        files: {
          "src/App.tsx":
            'import {nanoid} from "nanoid";const id=nanoid(12);export default function App(){return <p>ID {id}</p>}',
        },
      };
      const frames = [];
      const results = [];
      let candidate = project;
      try {
        for (let index = 0; index < 2; index++) {
          // Separate compiler instances prove Cache Storage reuse, rather than only an in-memory hit.
          const compiler = new BrowserCompiler();
          const started = performance.now();
          let built;
          try {
            built = await compiler.compile(candidate, `live-npm-${index}`);
          } finally {
            compiler.dispose();
          }
          if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
          candidate = built.project;
          const container = document.createElement("div");
          document.body.append(container);
          const appId = crypto.randomUUID();
          const frame = await FrameSession.mount({
            appId,
            container,
            mode: "app",
            state: {},
            observe: false,
            onRequest: () => null,
          });
          frames.push(frame);
          const applied = await frame.request("apply", built.artifact);
          results.push({
            appId,
            durationMs: performance.now() - started,
            metrics: built.artifact.metrics,
            applied,
          });
        }
      } finally {
        for (const frame of frames) frame.close();
      }
      return { project: candidate, results };
    }, `/@fs${process.cwd()}`);
    expect(result.results[0]!.metrics.networkRequests).toBeGreaterThanOrEqual(
      2,
    );
    expect(result.results[1]!.metrics.networkRequests).toBe(0);
    expect(result.results[1]!.metrics.cacheHits).toBeGreaterThanOrEqual(2);
    expect(result.results[0]!.appId).not.toBe(result.results[1]!.appId);
    for (const row of result.results)
      expect(row.applied.inspection.text).toMatch(/ID [A-Za-z0-9_-]{12}/);
    const evidence = JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        source:
          "Fresh HTTPS esm.sh responses through curl with configured environment proxy and CA trust, forwarded into browser fetch with Playwright route. No replayed package responses. This checks real package compatibility/cache, not unmodified browser-to-gateway networking.",
        responses,
        results: result.results,
      },
      null,
      2,
    );
    await writeFile(
      testInfo.outputPath("live-dependency-results.json"),
      `${evidence}\n`,
    );
    await testInfo.attach("live-dependency.json", {
      body: evidence,
      contentType: "application/json",
    });
  } finally {
    await context.unroute("https://esm.sh/**");
  }
});
