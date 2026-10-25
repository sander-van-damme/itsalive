import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { initSync } from "@swc/wasm-web";
import { CompilerCore, compileModule } from "../src/compiler/core";
import { DependencyCache } from "../src/compiler/cache";
import { resolveModule } from "../src/compiler/resolve";
import type { Project } from "../src/shared/types";

beforeAll(() => {
  initSync({ module: readFileSync("node_modules/@swc/wasm-web/wasm_bg.wasm") });
});
const seed = (): Project => ({
  entry: "src/App.tsx",
  dependencies: {},
  lock: {},
  files: {
    "src/App.tsx":
      'import {Label} from "./Label"; export default function App(){return <Label/>}',
    "src/Label.tsx": "export function Label(){return <span>Hello</span>}",
  },
});
const compiler = (fetcher?: typeof fetch) =>
  new CompilerCore(new DependencyCache(fetcher), async () => {});

describe("actual SWC module compiler", () => {
  it("accepts a legitimate project beyond the former source-file ceiling", async () => {
    const project = seed();
    for (let i = 0; i < 520; i++)
      project.files[`lessons/lesson-${i}.json`] = JSON.stringify({
        title: `Lesson ${i}`,
      });
    const result = await compiler().compile(project, "large-project");
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.project.files)).toHaveLength(522);
  });
  it("compiles multi-file TSX and rewrites imports without corrupting Unicode strings", async () => {
    const project = seed();
    project.files["src/App.tsx"] =
      'import {Label} from "./Label";const text="été 🦊 require(\\"not-a-package\\")"; export default function App(){return <div>{text}<Label/></div>}';
    const result = await compiler().compile(project, "one");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.modules["src/App.tsx"]!.code).toContain(
      'require("src/Label.tsx")',
    );
    expect(result.artifact.modules["src/App.tsx"]!.code).toContain(
      "$RefreshReg$",
    );
    expect(result.artifact.modules["src/App.tsx"]!.code).toContain(
      "not-a-package",
    );
    expect(result.artifact.metrics.transformedModules).toBe(2);
    expect(result.project.files).toEqual(project.files);
  });
  it("only transforms changed modules and leaves failed candidates repairable", async () => {
    const instance = compiler();
    const project = seed();
    const first = await instance.compile(project, "one");
    expect(first.ok).toBe(true);
    project.files["src/Label.tsx"] =
      "export function Label(){return <span>Updated</span>}";
    const next = await instance.compile(project, "two");
    expect(next.ok && next.artifact.metrics.transformedModules).toBe(1);
    project.files["src/Label.tsx"] = "export function Label( { return <";
    const broken = await instance.compile(project, "three");
    expect(broken.ok).toBe(false);
    expect(first.ok && first.artifact.modules["src/Label.tsx"]!.code).toContain(
      "Hello",
    );
    project.files["src/Label.tsx"] =
      "export function Label(){return <span>Fixed</span>}";
    const repaired = await instance.compile(project, "four");
    expect(repaired.ok).toBe(true);
  });
  it("bundles CSS with SVG data URLs and JSON imports", async () => {
    const project = seed();
    project.files["src/App.tsx"] =
      'import "./styles.css"; import data from "./data.json"; export default function App(){return <p>{data.name}</p>}';
    project.files["src/styles.css"] = 'p{background:url("./image.svg")}';
    project.files["src/image.svg"] =
      '<svg xmlns="http://www.w3.org/2000/svg"/>';
    project.files["src/data.json"] = '{"name":"Ada"}';
    const result = await compiler().compile(project, "css");
    expect(result.ok && result.artifact.css).toContain(
      "data:image/svg+xml;base64,",
    );
    expect(
      result.ok && result.artifact.modules["src/data.json"]!.code,
    ).toContain("Ada");
  });
  it("rejects Node dependencies, missing packages and computed imports with actionable errors", async () => {
    for (const [source, message] of [
      ['import fs from "node:fs"; export default fs;', "Node.js APIs"],
      ['import value from "unknown"; export default value;', "not declared"],
      [
        'const name="thing";export default import(name);',
        "literal module specifier",
      ],
    ]) {
      const project = seed();
      project.files["src/App.tsx"] = source!;
      const result = await compiler().compile(project, "bad");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics[0]!.message).toContain(message);
    }
  });
  it("preserves source while resolving pinned transitive packages and sharing cached bytes", async () => {
    const project = seed();
    project.dependencies["example-package"] = "1.0.0";
    project.files["src/App.tsx"] =
      'import {answer} from "example-package";export default function App(){return <p>{answer}</p>}';
    let downloads = 0;
    const fakeFetch: typeof fetch = async (input) => {
      downloads++;
      return new Response(
        String(input).includes("?")
          ? 'export {answer} from "/example-package@1.0.0/es2022/example-package.mjs";'
          : "export const answer=42;",
      );
    };
    const instance = compiler(fakeFetch);
    const first = await instance.compile(project, "app-a");
    expect(first.ok).toBe(true);
    expect(downloads).toBe(2);
    if (!first.ok) return;
    expect(Object.keys(first.project.lock)).toHaveLength(2);
    expect(project.lock).toEqual({});
    const second = await instance.compile(first.project, "app-b");
    expect(second.ok && second.artifact.metrics.networkRequests).toBe(0);
    expect(second.ok && second.artifact.metrics.cacheHits).toBe(2);
    expect(downloads).toBe(2);
    const locked = structuredClone(first.project);
    Object.values(locked.lock)[0]!.integrity = "sha256-changed";
    const mismatch = await instance.compile(locked, "mismatch");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok)
      expect(mismatch.diagnostics[0]!.message).toContain("Integrity mismatch");
  });
  it("checks imports in unchanged files when the project file graph changes", async () => {
    const instance = compiler();
    const project = seed();
    expect((await instance.compile(project, "one")).ok).toBe(true);
    delete project.files["src/Label.tsx"];
    const result = await instance.compile(project, "two");
    expect(result.ok).toBe(false);
  });
});

describe("dependency resolution policy", () => {
  it("rejects non-exact dependencies and project escapes", () => {
    const project = seed();
    project.dependencies["tiny"] = "^1.0.0";
    expect(() => resolveModule("tiny", project.entry, project)).toThrow(
      "exact version",
    );
    expect(() => resolveModule("../../escape", project.entry, project)).toThrow(
      "escapes",
    );
  });
  it("canonicalizes CDN framework URLs and rejects incompatible major versions", () => {
    const importer = "https://esm.sh/example@1.0.0/es2022/example.mjs";
    expect(
      resolveModule("/react@19.2.0/es2022/react.mjs", importer, seed()),
    ).toBe("react");
    expect(
      resolveModule("/react-dom@19.2.0/client?target=es2022", importer, seed()),
    ).toBe("react-dom/client");
    expect(
      resolveModule("/zustand@5.0.8/es2022/vanilla.mjs", importer, seed()),
    ).toBe("zustand/vanilla");
    expect(() =>
      resolveModule("/react@18.3.1/es2022/react.mjs", importer, seed()),
    ).toThrow("stable runtime");
  });
  it("uses platform modules without downloading a second React copy", () => {
    expect(
      resolveModule(
        "react/jsx-dev-runtime",
        "https://esm.sh/some-package@1/index.mjs",
        seed(),
      ),
    ).toBe("react/jsx-dev-runtime");
    const result = compileModule(
      "export default () => <p/>",
      "src/App.tsx",
      (value) => value,
    );
    expect(result.imports).toContain("react/jsx-dev-runtime");
  });
});
