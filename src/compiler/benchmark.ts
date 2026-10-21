import * as esbuild from "esbuild-wasm/esm/browser.js";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { CompilerCore, initializeSwc } from "./core";
import type { Project } from "../shared/types";

export interface CompilerBenchmark {
  userAgent: string;
  samples: number;
  swc: {
    initializationMs: number;
    coldMs: number;
    singleFileMs: number[];
    multiFileMs: number[];
    transformedModules: number[];
  };
  esbuild: {
    initializationMs: number;
    coldMs: number;
    singleFileMs: number[];
    multiFileMs: number[];
  };
  limitations: string[];
}
let esbuildReady: Promise<void> | undefined;
export function initializeEsbuild(): Promise<void> {
  return (esbuildReady ??= esbuild.initialize({
    wasmURL: esbuildWasmUrl,
    worker: true,
  }));
}
const seed: Project = {
  entry: "src/App.tsx",
  dependencies: {},
  lock: {},
  files: {
    "src/App.tsx":
      'import React,{useState} from "react";import {Label} from "./Label";import {sum} from "./math"; export default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}><Label/> {sum(n,1)}</button>}',
    "src/Label.tsx": "export function Label(){return <span>Count 0</span>}",
    "src/math.ts": "export function sum(a:number,b:number):number{return a+b}",
  },
};
export async function benchmarkCompilers(
  samples = 12,
): Promise<CompilerBenchmark> {
  const project = structuredClone(seed);
  let started = performance.now();
  await initializeSwc();
  const swcInitialization = performance.now() - started;
  const compiler = new CompilerCore();
  started = performance.now();
  const cold = await compiler.compile(project, "bench-cold");
  const swcCold = performance.now() - started;
  if (!cold.ok) throw new Error(JSON.stringify(cold.diagnostics));
  const swc = {
    initializationMs: swcInitialization,
    coldMs: swcCold,
    singleFileMs: [] as number[],
    multiFileMs: [] as number[],
    transformedModules: [] as number[],
  };
  for (let index = 1; index <= samples; index++) {
    project.files["src/Label.tsx"] =
      `export function Label(){return <span>Count ${index}</span>}`;
    started = performance.now();
    const single = await compiler.compile(project, `bench-${index}`);
    swc.singleFileMs.push(performance.now() - started);
    if (!single.ok) throw new Error(JSON.stringify(single.diagnostics));
    swc.transformedModules.push(single.artifact.metrics.transformedModules!);
    project.files["src/math.ts"] =
      `export function sum(a:number,b:number):number{return a+b+${index}}`;
    project.files["src/Label.tsx"] =
      `export function Label(){return <span>Multi ${index}</span>}`;
    started = performance.now();
    const multi = await compiler.compile(project, `bench-multi-${index}`);
    swc.multiFileMs.push(performance.now() - started);
    if (!multi.ok) throw new Error(JSON.stringify(multi.diagnostics));
  }
  started = performance.now();
  await initializeEsbuild();
  const esbuildInitialization = performance.now() - started;
  Object.assign(project.files, seed.files);
  const context = await esbuild.context({
    entryPoints: ["src/App.tsx"],
    bundle: true,
    write: false,
    format: "cjs",
    target: "es2022",
    jsx: "automatic",
    jsxDev: true,
    plugins: [
      {
        name: "virtual-project",
        setup(build) {
          build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
          build.onResolve({ filter: /.*/ }, (args) => {
            const candidate = args.importer
              ? `${args.importer.slice(0, args.importer.lastIndexOf("/") + 1)}${args.path.replace(/^\.\//, "")}`
              : args.path;
            const path = [
              candidate,
              `${candidate}.tsx`,
              `${candidate}.ts`,
            ].find((value) => Object.hasOwn(project.files, value));
            return path
              ? { path, namespace: "virtual" }
              : { errors: [{ text: `Missing ${candidate}` }] };
          });
          build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => ({
            contents: project.files[args.path]!,
            loader: args.path.endsWith("tsx") ? "tsx" : "ts",
          }));
        },
      },
    ],
  });
  const esbuildResult = {
    initializationMs: esbuildInitialization,
    coldMs: 0,
    singleFileMs: [] as number[],
    multiFileMs: [] as number[],
  };
  try {
    started = performance.now();
    await context.rebuild();
    esbuildResult.coldMs = performance.now() - started;
    for (let index = 1; index <= samples; index++) {
      project.files["src/Label.tsx"] =
        `export function Label(){return <span>Count ${index}</span>}`;
      started = performance.now();
      await context.rebuild();
      esbuildResult.singleFileMs.push(performance.now() - started);
      project.files["src/math.ts"] =
        `export function sum(a:number,b:number):number{return a+b+${index}}`;
      project.files["src/Label.tsx"] =
        `export function Label(){return <span>Multi ${index}</span>}`;
      started = performance.now();
      await context.rebuild();
      esbuildResult.multiFileMs.push(performance.now() - started);
    }
  } finally {
    await context.dispose();
  }
  return {
    userAgent: navigator.userAgent,
    samples,
    swc,
    esbuild: esbuildResult,
    limitations: [
      "Both measurements execute real browser WASM. Timings include resolution and compilation but exclude React commit/paint and worker-message transport.",
      "esbuild has no built-in React Refresh transform: the bundled comparison does not establish state-preserving HMR.",
      "Initialization is measured when this worker first uses each compiler; HTTP/compiler caches can reduce repeated-run cost.",
      "This three-file fixture is an engineering benchmark, not a prediction for every application or device.",
    ],
  };
}

// Benchmark-only alternative: a persistent esbuild bundler context, with platform modules external.
// Kept out of the product compilation path because it lacks Refresh instrumentation.
let comparisonProject: Project;
let comparisonContext: esbuild.BuildContext | undefined;
let comparisonEntry = "";
export async function compileEsbuildComparison(
  project: Project,
  revisionId: string,
): Promise<import("../shared/types").BuildResult> {
  const start = performance.now();
  try {
    await initializeEsbuild();
    comparisonProject = project;
    if (!comparisonContext || comparisonEntry !== project.entry) {
      await comparisonContext?.dispose();
      comparisonEntry = project.entry;
      const { resolveLocal, normalizePath, PLATFORM_MODULES } = await import(
        "./resolve"
      );
      comparisonContext = await esbuild.context({
        entryPoints: [project.entry],
        bundle: true,
        write: false,
        format: "cjs",
        target: "es2022",
        jsx: "automatic",
        jsxDev: true,
        plugins: [
          {
            name: "comparison-project",
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (PLATFORM_MODULES.has(args.path))
                  return { path: args.path, external: true };
                try {
                  const path =
                    args.importer && args.path.startsWith(".")
                      ? normalizePath(
                          `${args.importer.slice(0, args.importer.lastIndexOf("/") + 1)}${args.path}`,
                        )
                      : args.path;
                  return {
                    path: resolveLocal(path, comparisonProject),
                    namespace: "comparison",
                  };
                } catch (error) {
                  return { errors: [{ text: String(error) }] };
                }
              });
              build.onLoad(
                { filter: /.*/, namespace: "comparison" },
                (args) => ({
                  contents: comparisonProject.files[args.path]!,
                  loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
                }),
              );
            },
          },
        ],
      });
    }
    const result = await comparisonContext.rebuild();
    const code = result.outputFiles?.[0]?.text;
    if (!code) throw new Error("esbuild comparison returned no output");
    const { digest } = await import("./cache");
    return {
      ok: true,
      project,
      artifact: {
        entry: "esbuild-benchmark.cjs",
        modules: {
          "esbuild-benchmark.cjs": {
            code,
            hash: await digest(new TextEncoder().encode(code)),
          },
        },
        css: "",
        revisionId,
        metrics: { totalMs: performance.now() - start },
      },
    };
  } catch (error) {
    return { ok: false, diagnostics: [{ message: String(error) }] };
  }
}
