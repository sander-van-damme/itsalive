import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { CompilerBenchmark } from "../src/compiler/benchmark";

test("benchmarks real browser SWC module edits and esbuild incremental bundles", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const result = await page.evaluate(
    async (url): Promise<CompilerBenchmark> => {
      const { BrowserCompiler } = await import(url);
      const compiler = new BrowserCompiler();
      try {
        return await compiler.benchmark();
      } finally {
        compiler.dispose();
      }
    },
    `/@fs${process.cwd()}/src/compiler/index.ts`,
  );
  expect(result.samples).toBeGreaterThanOrEqual(10);
  expect(result.swc.transformedModules.every((value) => value === 1)).toBe(
    true,
  );
  expect(result.swc.singleFileMs.every((value) => value >= 0)).toBe(true);
  expect(result.esbuild.singleFileMs.every((value) => value > 0)).toBe(true);
  const evidence = { measuredAt: new Date().toISOString(), ...result };
  const text = JSON.stringify(evidence, null, 2);
  await writeFile("docs/benchmark-results.json", `${text}\n`);
  await testInfo.attach("compiler-benchmark.json", {
    body: text,
    contentType: "application/json",
  });
});

test("measures compile to visible update on isolated origins for both compiler strategies", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const ids = await page.evaluate(async (root) => {
    const { BrowserCompiler } = await import(`${root}/src/compiler/index.ts`);
    const { FrameSession } = await import(`${root}/src/shell/frame.ts`);
    const fixture = {
      entry: "src/App.tsx",
      dependencies: {},
      lock: {},
      files: {
        "src/App.tsx":
          'import {useState} from "react";import {Label} from "./Label";export default function App(){const [n,setN]=useState(0);return <div><Label/><button onClick={()=>setN(n+1)}>Count {n}</button></div>}',
        "src/Label.tsx": "export function Label(){return <p>Sample 0</p>}",
      },
    };
    const rows = [];
    for (const engine of ["swc", "esbuild"]) {
      const compiler = new BrowserCompiler();
      const container = document.createElement("section");
      container.style.cssText =
        "width:600px;height:220px;position:relative;background:white;color:black";
      document.body.prepend(container);
      const appId = crypto.randomUUID();
      const frame = await FrameSession.mount({
        appId,
        container,
        mode: "app",
        state: {},
        observe: false,
        onRequest: () => null,
      });
      frame.iframe.style.cssText = "width:100%;height:200px";
      const project = structuredClone(fixture);
      const initial =
        engine === "swc"
          ? await compiler.compile(project, `${engine}-0`)
          : await compiler.compileComparison(project, `${engine}-0`);
      if (!initial.ok) throw new Error(JSON.stringify(initial.diagnostics));
      await frame.request("apply", initial.artifact);
      rows.push({ engine, compiler, frame, project, appId });
    }
    Object.assign(window, { __compilerBenchmark: rows });
    return rows.map((row) => ({ engine: row.engine, appId: row.appId }));
  }, `/@fs${process.cwd()}`);
  for (const row of ids)
    await page
      .frameLocator(`iframe[data-app-id="${row.appId}"]`)
      .getByRole("button", { name: "Count 0" })
      .click();
  const result = await page.evaluate(async () => {
    const rows = (
      window as unknown as {
        __compilerBenchmark: {
          engine: string;
          compiler: import("../src/compiler").BrowserCompiler;
          frame: import("../src/shell/frame").FrameSession;
          project: import("../src/shared/types").Project;
        }[];
      }
    ).__compilerBenchmark;
    const results = [];
    try {
      for (const row of rows) {
        const samples = [];
        let retained = true;
        for (let index = 1; index <= 12; index++) {
          row.project.files["src/Label.tsx"] =
            `export function Label(){return <p>Sample ${index}</p>}`;
          const started = performance.now();
          const built =
            row.engine === "swc"
              ? await row.compiler.compile(
                  row.project,
                  `${row.engine}-${index}`,
                )
              : await row.compiler.compileComparison(
                  row.project,
                  `${row.engine}-${index}`,
                );
          if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
          const applied = await row.frame.request<{
            inspection: { text: string };
          }>("apply", built.artifact);
          samples.push(performance.now() - started);
          if (!applied.inspection.text.includes(`Sample ${index}`))
            throw new Error("Updated source was not visible");
          retained &&= applied.inspection.text.includes("Count 1");
        }
        results.push({
          engine: row.engine,
          editToVisibleMs: samples,
          localStateRetained: retained,
        });
      }
    } finally {
      for (const row of rows) {
        row.frame.close();
        row.compiler.dispose();
      }
    }
    return {
      samples: 12,
      results,
      scope:
        "Real browser worker compilation, transport, authenticated app bridge, React render, and two animation frames. Excludes separate candidate-verification iframe and persistence.",
    };
  });
  expect(
    result.results.find((row) => row.engine === "swc")?.localStateRetained,
  ).toBe(true);
  expect(
    result.results.find((row) => row.engine === "esbuild")?.localStateRetained,
  ).toBe(false);
  const evidence = JSON.stringify(
    { measuredAt: new Date().toISOString(), ...result },
    null,
    2,
  );
  await writeFile("docs/benchmark-visible-results.json", `${evidence}\n`);
  await testInfo.attach("compiler-visible-benchmark.json", {
    body: evidence,
    contentType: "application/json",
  });
});

test("records complete accepted-edit lifecycle, reload and repeated-edit heap estimates", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.waitForFunction(() => "__itsalive" in window);
  const result = await page.evaluate(async () => {
    type API = {
      createApp(name: string): Promise<unknown>;
      edit(files: Record<string, string>): Promise<unknown>;
      inspect(): Promise<{ text: string }>;
      getApp(): { id: string };
    };
    const api = (window as unknown as { __itsalive: API }).__itsalive;
    const heap = () =>
      (
        performance as unknown as {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
    const started = performance.now();
    await api.createApp("Performance fixture");
    const initialCreateMs = performance.now() - started;
    await api.edit({
      "src/App.tsx":
        'import {Label} from "./Bench";export default function App(){return <Label/>}',
      "src/Bench.tsx": "export function Label(){return <p>Edit 0</p>}",
    });
    const before = heap();
    const heapBefore = before
      ? { used: before.usedJSHeapSize, total: before.totalJSHeapSize }
      : null;
    const acceptedEditMs = [];
    for (let index = 1; index <= 30; index++) {
      const begin = performance.now();
      await api.edit({
        "src/Bench.tsx": `export function Label(){return <p>Edit ${index}</p>}`,
      });
      acceptedEditMs.push(performance.now() - begin);
      if (!(await api.inspect()).text.includes(`Edit ${index}`))
        throw new Error(`Edit ${index} not visible`);
    }
    const after = heap();
    return {
      userAgent: navigator.userAgent,
      appId: api.getApp().id,
      initialCreateMs,
      acceptedEditMs,
      heapBefore,
      heapAfter: after
        ? { used: after.usedJSHeapSize, total: after.totalJSHeapSize }
        : null,
      scope:
        "Accepted source edit through state flush, browser compilation, isolated candidate verification and cleanup, live update, revision commit and persistent-state flush.",
      memoryCaveat:
        "Chromium performance.memory is a coarse, process-sharing-dependent heap estimate; no forced garbage collection. Includes UI/history growth. Not a leak or total browser memory measurement.",
    };
  });
  const reloadStarted = performance.now();
  await page.reload();
  await page.waitForFunction(async () => {
    const api = (
      window as unknown as {
        __itsalive?: { inspect(): Promise<{ text: string }> };
      }
    ).__itsalive;
    if (!api) return false;
    try {
      return (await api.inspect()).text.includes("Edit 30");
    } catch {
      return false;
    }
  });
  const reloadToReadyMs = performance.now() - reloadStarted;
  expect(result.acceptedEditMs).toHaveLength(30);
  const evidence = JSON.stringify(
    { measuredAt: new Date().toISOString(), ...result, reloadToReadyMs },
    null,
    2,
  );
  await writeFile("docs/benchmark-lifecycle-results.json", `${evidence}\n`);
  await testInfo.attach("lifecycle-benchmark.json", {
    body: evidence,
    contentType: "application/json",
  });
});
