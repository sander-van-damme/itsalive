import {
  test,
  expect,
  type Page,
  type Frame,
  type BrowserContext,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import type {
  AppRecord,
  BuildResult,
  Diagnostic,
  Project,
  Revision,
  RuntimeInspection,
} from "../src/shared/types";

interface TestAPI {
  getProject(): Promise<Project>;
  getApp(): Promise<AppRecord>;
  getRevision(): Promise<Revision>;
  listApps(): Promise<AppRecord[]>;
  createApp(name: string): Promise<unknown>;
  openApp(id: string): Promise<void>;
  edit(
    files: Record<string, string>,
    dependencies?: Record<string, string>,
  ): Promise<unknown>;
  inspect(): Promise<RuntimeInspection>;
  exportBackup(): Promise<Blob>;
  importBackup(blob: Blob): Promise<void>;
  diagnostics(): Promise<Diagnostic[]>;
  observe(target: string, count?: number): Promise<unknown>;
  setObservation(enabled: boolean): Promise<void>;
  rollback(revision: string): Promise<unknown>;
  compiler: {
    compile(project: Project, revisionId: string): Promise<BuildResult>;
  };
}
declare global {
  interface Window {
    __itsalive: TestAPI;
  }
}

const APP_SOURCE = `import React from 'react';
import Counter from './components/Counter';
import { useStore, setState } from '@itsalive/store';
import './styles.css';
export default function App() {
  const saved = useStore(state => Number(state.saved || 0));
  return <main><h1>Living counter</h1><Counter/><button onClick={() => setState({saved: saved + 1})}>Saved: {saved}</button></main>;
}`;
const COUNTER_SOURCE = `import React, { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`;

async function ready(page: Page): Promise<void> {
  await page.goto("http://itsalive.localhost:4173/?test-provider=scripted");
  await page.waitForFunction(() => Boolean(window.__itsalive));
}
async function appFrame(page: Page): Promise<Frame> {
  const iframe = page.locator('iframe[data-mode="app"]');
  await expect(iframe).toHaveCount(1);
  const handle = await iframe.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("Application iframe is missing");
  await expect(frame.locator("main")).toBeVisible();
  return frame;
}
// Architecture fixtures are explicit test data, never the normal first-run app.
async function create(page: Page, name = "Browser acceptance"): Promise<Frame> {
  await page.evaluate((name) => window.__itsalive.createApp(name), name);
  const result = await edit(page, {
    "src/App.tsx": APP_SOURCE.replace("Living counter", name),
    "src/components/Counter.tsx": COUNTER_SOURCE,
  });
  expect(result.error).toBeNull();
  const frame = await appFrame(page);
  await expect(frame.getByRole("heading", { name, exact: true })).toBeVisible();
  return frame;
}
async function openSettings(page: Page) {
  if (await page.locator("#settings-dialog").isVisible()) return;
  await page.locator("#more-options > summary").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
async function openDiagnostics(page: Page) {
  await openSettings(page);
  await page.getByText("Help and diagnostics", { exact: true }).click();
}
async function edit(
  page: Page,
  files: Record<string, string>,
  dependencies?: Record<string, string>,
) {
  return page.evaluate(
    async ({ files, dependencies }) => {
      try {
        return {
          error: null,
          result: await window.__itsalive.edit(files, dependencies),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          result: null,
        };
      }
    },
    { files, dependencies },
  );
}
async function fixture(page: Page): Promise<Frame> {
  await create(page);
  const result = await edit(page, {
    "src/App.tsx": APP_SOURCE,
    "src/components/Counter.tsx": COUNTER_SOURCE,
  });
  expect(result.error).toBeNull();
  const frame = await appFrame(page);
  await expect(
    frame.getByRole("heading", { name: "Living counter" }),
  ).toBeVisible();
  return frame;
}
async function revisionId(page: Page): Promise<string> {
  return page.evaluate(
    async () => (await window.__itsalive.getApp()).currentRevision,
  );
}

// Pinned upstream clsx 2.1.1 ESM, captured from esm.sh on 2026-10-21.
// The gateway wrapper is deterministic; the compiler still fetches, resolves,
// transforms, hashes and caches both real module responses in the browser.
const CLSX_MODULE = `function a(r){var n,f,t="";if(typeof r=="string"||typeof r=="number")t+=r;else if(typeof r=="object")if(Array.isArray(r)){var o=r.length;for(n=0;n<o;n++)r[n]&&(f=a(r[n]))&&(t&&(t+=" "),t+=f)}else for(f in r)r[f]&&(t&&(t+=" "),t+=f);return t}function e(){for(var r,n,f=0,t="",o=arguments.length;f<o;f++)(r=arguments[f])&&(n=a(r))&&(t&&(t+=" "),t+=n);return t}var i=e;export{e as clsx,i as default};`;
async function packageFixture(
  context: BrowserContext,
): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await context.route("https://esm.sh/**", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (!url.includes("clsx@2.1.1"))
      return route.fulfill({ status: 404, body: "Unrecorded dependency" });
    const body = url.includes("/es2022/clsx.mjs")
      ? CLSX_MODULE
      : 'export * from "/clsx@2.1.1/es2022/clsx.mjs"; export { default } from "/clsx@2.1.1/es2022/clsx.mjs";';
    await route.fulfill({
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
  });
  return { requests };
}

test.beforeEach(async ({ page }) => {
  await ready(page);
});

test("creates a real multi-file React application on an immutable isolated origin", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const frame = await create(page, "My living tool");
  await expect(
    frame.getByRole("heading", { name: "My living tool" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Count: 0", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Count: 1", exact: true }),
  ).toBeVisible();
  const project = await page.evaluate(() => window.__itsalive.getProject());
  expect(Object.keys(project.files).length).toBeGreaterThanOrEqual(3);
  expect(project.entry).toMatch(/\.tsx$/);
  const app = await page.evaluate(() => window.__itsalive.getApp());
  expect(new URL(frame.url()).hostname).toBe(`${app.id}.itsalive.localhost`);
  expect(new URL(frame.url()).origin).not.toBe(new URL(page.url()).origin);
  expect(errors).toEqual([]);
});

test("hot edits preserve transient and durable state, broken candidates leave the running revision intact", async ({
  page,
}) => {
  const frame = await fixture(page);
  await frame.getByRole("button", { name: "Count: 0", exact: true }).click();
  await frame.getByRole("button", { name: "Saved: 0", exact: true }).click();
  const frameURL = frame.url();
  const before = await revisionId(page);
  const broken = await edit(page, {
    "src/components/Counter.tsx":
      "export default function Counter( { return <broken",
  });
  expect(JSON.stringify(broken)).toMatch(/error|diagnostic|failed/i);
  expect(await revisionId(page)).toBe(before);
  await expect(
    frame.getByRole("button", { name: "Count: 1", exact: true }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Count: 1", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Count: 2", exact: true }),
  ).toBeVisible();
  const repaired = await edit(page, {
    "src/App.tsx": APP_SOURCE.replace("Living counter", "Updated while alive"),
    "src/components/Counter.tsx": COUNTER_SOURCE,
  });
  expect(repaired.error).toBeNull();
  await expect(
    frame.getByRole("heading", { name: "Updated while alive" }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Count: 2", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Saved: 1", exact: true }),
  ).toBeVisible();
  expect(frame.url()).toBe(frameURL);
  expect(await revisionId(page)).not.toBe(before);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  const restored = await appFrame(page);
  await expect(
    restored.getByRole("heading", { name: "Updated while alive" }),
  ).toBeVisible();
  await expect(
    restored.getByRole("button", { name: "Saved: 1", exact: true }),
  ).toBeVisible();
});

test("a component edit retains hook state and rollback restores a prior source revision", async ({
  page,
}) => {
  const frame = await fixture(page);
  await frame.getByRole("button", { name: "Count: 0", exact: true }).click();
  const before = await revisionId(page);
  const result = await edit(page, {
    "src/components/Counter.tsx": COUNTER_SOURCE.replace("Count: ", "Clicks: "),
  });
  expect(result.error).toBeNull();
  await expect(
    frame.getByRole("button", { name: "Clicks: 1", exact: true }),
  ).toBeVisible();
  await page.evaluate((id) => window.__itsalive.rollback(id), before);
  await expect(
    frame.getByRole("button", { name: "Count: 1", exact: true }),
  ).toBeVisible();
});

test("runtime verification rejects a crashing candidate without touching live origin data", async ({
  page,
}) => {
  const frame = await fixture(page);
  await frame.evaluate(() =>
    localStorage.setItem("verification-sentinel", "live-value"),
  );
  const before = await revisionId(page);
  const result = await edit(page, {
    "src/App.tsx": `import React from 'react'; localStorage.setItem('verification-sentinel', 'candidate-write'); export default function App(){ throw new Error('deliberate candidate render failure'); }`,
  });
  expect(JSON.stringify(result)).toMatch(/error|fail/i);
  expect(await revisionId(page)).toBe(before);
  await expect(
    frame.getByRole("heading", { name: "Living counter" }),
  ).toBeVisible();
  expect(
    await frame.evaluate(() => localStorage.getItem("verification-sentinel")),
  ).toBe("live-value");
});

test("npm dependencies resolve, lock and reuse the shell cache across separate application origins and reload", async ({
  page,
  context,
}) => {
  const network = await packageFixture(context);
  await create(page, "Dependency one");
  const source = `import React from 'react'; import clsx from 'clsx'; export default function App(){return <main><h1 className={clsx('cached', { dependency: true })}>Dependency ready</h1></main>}`;
  const result = await edit(page, { "src/App.tsx": source }, { clsx: "2.1.1" });
  expect(result.error).toBeNull();
  const firstFrame = await appFrame(page);
  await expect(firstFrame.getByRole("heading")).toHaveClass(
    "cached dependency",
  );
  const firstOrigin = new URL(firstFrame.url()).origin;
  expect(network.requests.length).toBeGreaterThanOrEqual(2);
  const coldRequests = network.requests.length;
  const project = await page.evaluate(() => window.__itsalive.getProject());
  expect(Object.keys(project.lock).length).toBeGreaterThanOrEqual(2);
  expect(
    Object.values(project.lock).every((entry) =>
      entry.integrity.startsWith("sha256-"),
    ),
  ).toBe(true);
  await create(page, "Dependency two");
  expect(
    (await edit(page, { "src/App.tsx": source }, { clsx: "2.1.1" })).error,
  ).toBeNull();
  const secondFrame = await appFrame(page);
  expect(new URL(secondFrame.url()).origin).not.toBe(firstOrigin);
  await expect(secondFrame.getByRole("heading")).toHaveClass(
    "cached dependency",
  );
  expect(network.requests.length).toBe(coldRequests);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await expect((await appFrame(page)).getByRole("heading")).toHaveClass(
    "cached dependency",
  );
  expect(network.requests.length).toBe(coldRequests);
});

test("Node-only imports produce actionable diagnostics while the app remains usable", async ({
  page,
}) => {
  const frame = await fixture(page);
  const before = await revisionId(page);
  const result = await edit(page, {
    "src/App.tsx": `import fs from 'node:fs'; export default function App(){return fs.readFileSync('/etc/passwd')}`,
  });
  expect(JSON.stringify(result)).toMatch(/Node|browser/i);
  expect(await revisionId(page)).toBe(before);
  await frame.getByRole("button", { name: "Count: 0", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Count: 1", exact: true }),
  ).toBeVisible();
});

test("generated app text and bounded decisions use the shell provider without credentials", async ({
  page,
}) => {
  await create(page);
  const result = await edit(page, {
    "src/App.tsx": `import React,{useState} from 'react'; import {text,decide} from '@itsalive/ai'; export default function App(){const [answer,setAnswer]=useState('');return <main><h1>AI bridge</h1><button onClick={async()=>setAnswer(await text('Say hello'))}>Ask text</button><button onClick={async()=>setAnswer(String(await decide('Is two plus two four?')))}>Ask decision</button><output>{answer}</output></main>}`,
  });
  expect(result.error).toBeNull();
  const frame = await appFrame(page);
  await frame.getByRole("button", { name: "Ask text", exact: true }).click();
  await expect(frame.locator("output")).not.toHaveText("");
  await frame
    .getByRole("button", { name: "Ask decision", exact: true })
    .click();
  await expect(frame.locator("output")).toHaveText(/^(true|false)$/);
  const diagnostics = await page.evaluate(() =>
    window.__itsalive.diagnostics(),
  );
  expect(JSON.stringify(diagnostics)).toMatch(/application/);
});

test("explicit conversation requests automatically create a durable functional task list", async ({
  page,
}) => {
  await create(page);
  const before = await revisionId(page);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Create a task list");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply change", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => revisionId(page), { timeout: 30_000 })
    .not.toBe(before);
  const frame = await appFrame(page);
  await expect(
    frame.getByRole("heading", { name: "My tasks", exact: true }),
  ).toBeVisible();
  await frame
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("Practice violin scales");
  await frame.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(
    frame.getByRole("button", {
      name: "Complete Practice violin scales",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__itsalive.getApp()).state.tasks),
    )
    .toEqual(["Practice violin scales"]);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  const restored = await appFrame(page);
  await restored
    .getByRole("button", {
      name: "Complete Practice violin scales",
      exact: true,
    })
    .click();
  await expect(
    restored.getByRole("button", {
      name: "Complete Practice violin scales",
      exact: true,
    }),
  ).toHaveCount(0);
  const traces = await page.evaluate(() => window.__itsalive.diagnostics());
  expect(JSON.stringify(traces)).toMatch(/coding/);
});

test("meaningful behavior yields a non-blocking suggestion and dismissal or ignoring never changes source", async ({
  page,
}) => {
  await fixture(page);
  expect(
    (
      await edit(page, {
        "src/App.tsx": APP_SOURCE.replace(
          "<Counter/>",
          "<Counter/><button>Save button</button>",
        ),
      })
    ).error,
  ).toBeNull();
  const beforeConsent = await appFrame(page);
  for (let index = 0; index < 4; index++)
    await beforeConsent
      .getByRole("button", { name: "Save button", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Try this", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__itsalive.setObservation(true));
  await expect(page.locator('iframe[data-mode="app"]')).toHaveAttribute(
    "src",
    beforeConsent.url(),
  );
  const frame = await appFrame(page);
  const before = await revisionId(page);
  for (let index = 0; index < 4; index++)
    await frame
      .getByRole("button", { name: "Save button", exact: true })
      .click();
  const apply = page.getByRole("button", {
    name: "Try this",
    exact: true,
  });
  await expect(apply).toBeVisible();
  expect(await revisionId(page)).toBe(before);
  await frame.getByRole("button", { name: "Count: 0", exact: true }).click();
  await expect(
    frame.getByRole("button", { name: "Count: 1", exact: true }),
  ).toBeVisible();
  expect(await revisionId(page)).toBe(before);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(apply).toHaveCount(0);
  expect(await revisionId(page)).toBe(before);
});

test("application origins cannot read shell credentials or another application storage", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem(
      "shell-only-credential-sentinel",
      "DO-NOT-CROSS-ORIGIN",
    ),
  );
  const first = await fixture(page);
  const appA = await page.evaluate(() => window.__itsalive.getApp());
  await first.evaluate(() =>
    localStorage.setItem("app-private", "application-A"),
  );
  const denied = await first.evaluate(() => {
    try {
      return {
        denied: false,
        value: parent.localStorage.getItem("shell-only-credential-sentinel"),
      };
    } catch (error) {
      return {
        denied: error instanceof DOMException && error.name === "SecurityError",
        value: localStorage.getItem("shell-only-credential-sentinel"),
      };
    }
  });
  expect(denied).toEqual({ denied: true, value: null });
  const second = await create(page, "Independent app");
  expect(
    await second.evaluate(() => localStorage.getItem("app-private")),
  ).toBeNull();
  await second.evaluate(() =>
    localStorage.setItem("app-private", "application-B"),
  );
  await page.evaluate((id) => window.__itsalive.openApp(id), appA.id);
  const reopened = await appFrame(page);
  expect(
    await reopened.evaluate(() => localStorage.getItem("app-private")),
  ).toBe("application-A");
  const frameGlobals = await reopened.evaluate(() => {
    // HTML element IDs are exposed as named Window properties by browsers.
    // The mount's id="application" must not be confused with the retired API.
    const named = (window as unknown as Record<string, unknown>).application as
      | { ai?: unknown; store?: unknown }
      | undefined;
    return {
      applicationAI: typeof named?.ai,
      applicationStore: typeof named?.store,
      agent: typeof (window as unknown as Record<string, unknown>).agent,
    };
  });
  expect(frameGlobals).toEqual({
    applicationAI: "undefined",
    applicationStore: "undefined",
    agent: "undefined",
  });
});

test("backup restores source, revisions, shell state and origin storage in a clean browser context", async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(180_000);
  await packageFixture(context);
  const frame = await fixture(page);
  const dependencySource = APP_SOURCE.replace(
    "import React from 'react';",
    "import React from 'react'; import clsx from 'clsx';",
  ).replace(
    "<main>",
    '<main className={clsx("portable", {dependencies:true})}>',
  );
  expect(
    (await edit(page, { "src/App.tsx": dependencySource }, { clsx: "2.1.1" }))
      .error,
  ).toBeNull();
  await frame.getByRole("button", { name: "Saved: 0", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__itsalive.getApp()).state.saved),
    )
    .toBe(1);
  const source = await page.evaluate(() => window.__itsalive.getProject());
  const app = await page.evaluate(() => window.__itsalive.getApp());
  await frame.evaluate(async () => {
    localStorage.setItem("ordinary-origin-data", "portable");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("user-records", 3);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("notes", {
          keyPath: "id",
        });
        store.createIndex("byTitle", "title", { unique: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("notes", "readwrite");
      tx.objectStore("notes").put({
        id: "note-1",
        title: "Origin record",
        bytes: new Uint8Array([0, 7, 255]),
        created: new Date("2026-10-21T12:00:00.000Z"),
        payload: new Blob(["binary portable"], { type: "text/plain" }),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const cache = await caches.open("user-offline-cache");
    await cache.put(
      "/offline-note",
      new Response("cached portable", {
        headers: { "content-type": "text/plain" },
      }),
    );
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle("user.txt", { create: true });
    const writer = await file.createWritable();
    await writer.write("OPFS portable");
    await writer.close();
  });
  await page.evaluate(() =>
    localStorage.setItem("provider-secret-sentinel", "MUST-NOT-BE-EXPORTED"),
  );
  const bytes = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (await window.__itsalive.exportBackup()).arrayBuffer(),
      ),
    ),
  );
  expect(bytes.length).toBeGreaterThan(100);
  const clean = await browser.newContext();
  try {
    // A restored lock must be runnable with the archived shell package cache.
    await clean.route("https://esm.sh/**", (route) => route.abort());
    const restoredPage = await clean.newPage();
    await ready(restoredPage);
    expect(
      await restoredPage.evaluate(() => window.__itsalive.listApps()),
    ).toEqual([]);
    await restoredPage.evaluate(
      (bytes) =>
        window.__itsalive.importBackup(new Blob([new Uint8Array(bytes)])),
      bytes,
    );
    await restoredPage.evaluate((id) => window.__itsalive.openApp(id), app.id);
    const restored = await appFrame(restoredPage);
    expect(
      await restoredPage.evaluate(() => window.__itsalive.getProject()),
    ).toEqual(source);
    await expect(restored.locator("main")).toHaveClass("portable dependencies");
    await expect(
      restored.getByRole("button", { name: "Saved: 1", exact: true }),
    ).toBeVisible();
    expect(
      await restoredPage.evaluate(() =>
        localStorage.getItem("provider-secret-sentinel"),
      ),
    ).toBeNull();
    const data = await restored.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("user-records");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise<{
        title: string;
        bytes: Uint8Array;
        created: Date;
        payload: Blob;
      }>((resolve, reject) => {
        const tx = db.transaction("notes");
        const request = tx.objectStore("notes").get("note-1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const indexNames = Array.from(
        db.transaction("notes").objectStore("notes").indexNames,
      );
      const version = db.version;
      db.close();
      const cached = await (
        await caches.open("user-offline-cache")
      ).match("/offline-note");
      const opfs = await (
        await (await navigator.storage.getDirectory()).getFileHandle("user.txt")
      ).getFile();
      return {
        local: localStorage.getItem("ordinary-origin-data"),
        title: record.title,
        bytes: Array.from(record.bytes),
        created: record.created.toISOString(),
        blob: await record.payload.text(),
        version,
        indexNames,
        cached: await cached?.text(),
        opfs: await opfs.text(),
      };
    });
    expect(data).toEqual({
      local: "portable",
      title: "Origin record",
      bytes: [0, 7, 255],
      created: "2026-10-21T12:00:00.000Z",
      blob: "binary portable",
      version: 3,
      indexNames: ["byTitle"],
      cached: "cached portable",
      opfs: "OPFS portable",
    });
  } finally {
    await clean.close();
  }
});

test("a deliberately broken build produces exportable correlated diagnostics", async ({
  page,
}) => {
  await fixture(page);
  await edit(page, {
    "src/App.tsx": "export default function App(){return <div>broken",
  });
  const diagnostics = await page.evaluate(() =>
    window.__itsalive.diagnostics(),
  );
  const failure = diagnostics.find(
    (event) =>
      /fail|error/i.test(event.event) ||
      /error|failed|unexpected|unterminated/i.test(JSON.stringify(event.data)),
  );
  expect(failure).toBeDefined();
  expect(failure?.correlationId).toBeTruthy();
  expect(failure?.timestamp).toBeGreaterThan(0);
  expect(JSON.stringify(diagnostics)).toContain("src/App.tsx");
  await openDiagnostics(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download diagnostic logs", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("itsalive-diagnostics.json");
  const path = await download.path();
  if (!path) throw new Error("Diagnostic download was not saved");
  const exported = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    diagnostics: Diagnostic[];
  };
  expect(exported.version).toBe(3);
  expect(exported.diagnostics.some((event) => event.id === failure?.id)).toBe(
    true,
  );
});

test("Enter sends, Shift+Enter adds a line, and composition does not submit", async ({
  page,
}) => {
  await create(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const before = await revisionId(page);
  await input.fill("Change the title to Keyboard");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("Change the title to Keyboard\n");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(await revisionId(page)).toBe(before);
  await input.press("Enter");
  await expect.poll(() => revisionId(page)).not.toBe(before);
  await expect(
    (await appFrame(page)).getByRole("heading", {
      name: "Keyboard",
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
});

test("mobile users can reach model choices, optional budget, backup and diagnostic export", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await openSettings(page);
  const settings = page.locator("#settings-dialog");
  await settings.getByText("AI choices", { exact: true }).click();
  await expect(settings.getByLabel("Low model", { exact: true })).toBeVisible();
  await expect(
    settings.getByLabel("Live voice model", { exact: true }),
  ).toBeVisible();
  await settings.getByText("Usage", { exact: true }).click();
  await expect(
    settings.getByLabel("Enable spending limit", { exact: true }),
  ).not.toBeChecked();
  await settings.getByText("Backup and restore", { exact: true }).click();
  await settings
    .getByRole("button", { name: "Back up or restore all apps", exact: true })
    .click();
  const backup = page.locator("#backup-dialog");
  await expect(
    backup.getByRole("button", { name: "Download backup", exact: true }),
  ).toBeVisible();
  await backup
    .getByRole("button", { name: "Close backup and restore", exact: true })
    .click();
  await openDiagnostics(page);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download diagnostic logs", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "itsalive-diagnostics.json",
  );
});

test("switching applications during compilation rejects a stale edit without crossing revisions or state", async ({
  page,
}) => {
  const first = await fixture(page);
  await first.getByRole("button", { name: "Saved: 0", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__itsalive.getApp()).state.saved),
    )
    .toBe(1);
  const appA = await page.evaluate(() => window.__itsalive.getApp());
  const second = await create(page, "Another workspace");
  await second.getByRole("button", { name: "Saved: 0", exact: true }).click();
  await second.getByRole("button", { name: "Saved: 1", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.__itsalive.getApp()).state.saved),
    )
    .toBe(2);
  const appB = await page.evaluate(() => window.__itsalive.getApp());
  await page.evaluate((id) => window.__itsalive.openApp(id), appA.id);
  const result = await page.evaluate(
    async ({ destination, source }) => {
      const compiler = window.__itsalive.compiler;
      const original = compiler.compile.bind(compiler);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      // Delay the actual compiler invocation, then execute it normally. No build
      // result or revision operation is mocked; only scheduling is controlled.
      compiler.compile = async (project, revisionId) => {
        if (project.files["src/App.tsx"]?.includes("Pending edit marker")) {
          entered();
          await gate;
        }
        return original(project, revisionId);
      };
      try {
        const pending = window.__itsalive.edit({ "src/App.tsx": source }).then(
          (value) => ({ value, error: null }),
          (error) => ({
            value: null,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        await started;
        await window.__itsalive.openApp(destination);
        release();
        return await pending;
      } finally {
        release();
        compiler.compile = original;
      }
    },
    {
      destination: appB.id,
      source: APP_SOURCE.replace("Living counter", "Pending edit marker"),
    },
  );
  expect(result.error).toMatch(/changed|stale/i);
  const active = await page.evaluate(() => window.__itsalive.getApp());
  expect(active.id).toBe(appB.id);
  expect(active.currentRevision).toBe(appB.currentRevision);
  expect(active.state.saved).toBe(2);
  const remaining = await page.evaluate(() => window.__itsalive.listApps());
  expect(remaining.find((app) => app.id === appA.id)?.currentRevision).toBe(
    appA.currentRevision,
  );
  expect(remaining.find((app) => app.id === appA.id)?.state.saved).toBe(1);
  await expect(
    (await appFrame(page)).getByRole("heading", {
      name: "Another workspace",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate((id) => window.__itsalive.openApp(id), appA.id);
  const originalFrame = await appFrame(page);
  await expect(
    originalFrame.getByRole("heading", { name: "Living counter", exact: true }),
  ).toBeVisible();
  await expect(
    originalFrame.getByRole("button", { name: "Saved: 1", exact: true }),
  ).toBeVisible();
});

test("restoring an empty archive clears active app pointers and stays empty after reload", async ({
  page,
}) => {
  const empty = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(
        await (await window.__itsalive.exportBackup()).arrayBuffer(),
      ),
    ),
  );
  await create(page, "Replace this workspace");
  await page.evaluate(
    (bytes) =>
      window.__itsalive.importBackup(new Blob([new Uint8Array(bytes)])),
    empty,
  );
  expect(await page.evaluate(() => window.__itsalive.listApps())).toEqual([]);
  expect(await page.evaluate(() => window.__itsalive.getApp())).toBeNull();
  await expect(page.locator('iframe[data-mode="app"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Create an app/ }),
  ).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__itsalive));
  expect(await page.evaluate(() => window.__itsalive.listApps())).toEqual([]);
  await expect(page.locator('iframe[data-mode="app"]')).toHaveCount(0);
});
