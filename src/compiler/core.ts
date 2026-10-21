import initSwc, { parseSync, printSync, transformSync } from "@swc/wasm-web";
import wasmUrl from "@swc/wasm-web/wasm_bg.wasm?url";
import type { BuildResult, CompiledModule, Project } from "../shared/types";
import { dataUrl, DependencyCache, digest } from "./cache";
import {
  isRemote,
  normalizePath,
  PLATFORM_MODULES,
  resolveLocal,
  resolveModule,
} from "./resolve";

let initialization: Promise<void> | undefined;
export function initializeSwc(): Promise<void> {
  return (initialization ??= initSwc({ module_or_path: wasmUrl })
    .then(() => undefined)
    .catch((error) => {
      initialization = undefined;
      throw error;
    }));
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Ast = {
  type?: string;
  value?: string;
  raw?: string;
  callee?: Ast;
  arguments?: { expression: Ast }[];
  [key: string]: unknown;
};
function visit(node: unknown, callback: (node: Ast) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, callback));
    return;
  }
  const ast = node as Ast;
  callback(ast);
  for (const child of Object.values(ast))
    if (child && typeof child === "object") visit(child, callback);
}
export function compileModule(
  source: string,
  filename: string,
  resolve: (specifier: string) => string,
): { code: string; imports: string[] } {
  const extension = filename.split("?")[0]!.split(".").at(-1);
  const typescript = extension === "ts" || extension === "tsx";
  const transformed = transformSync(source, {
    filename,
    sourceMaps: false,
    jsc: {
      target: "es2022",
      parser: typescript
        ? { syntax: "typescript", tsx: extension === "tsx" }
        : { syntax: "ecmascript", jsx: extension === "jsx" },
      transform: {
        react: {
          runtime: "automatic",
          development: true,
          refresh: !isRemote(filename),
        },
      },
    },
    module: { type: "commonjs", strict: true },
  });
  const ast = parseSync(transformed.code, {
    syntax: "ecmascript",
    target: "es2022",
  });
  const imports = new Set<string>();
  visit(ast, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      node.callee.value !== "require"
    )
      return;
    const argument = node.arguments?.[0]?.expression;
    if (
      node.arguments?.length !== 1 ||
      argument?.type !== "StringLiteral" ||
      typeof argument.value !== "string"
    ) {
      throw new Error(
        `${filename}: computed imports/requires cannot be resolved ahead of time. Use a literal module specifier.`,
      );
    }
    const resolved = resolve(argument.value);
    argument.value = resolved;
    delete argument.raw;
    imports.add(resolved);
  });
  return {
    code: printSync(ast, { minify: false }).code,
    imports: [...imports],
  };
}
const assetMimes: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
  txt: "text/plain",
};

/** Executes in a dedicated worker. All package fetches/caches belong to the shell origin. */
export class CompilerCore {
  private transforms = new Map<
    string,
    {
      source: string;
      dependencies: string;
      code: string;
      imports: string[];
      hash: string;
    }
  >();
  constructor(
    readonly cache = new DependencyCache(),
    private readonly initialize = initializeSwc,
  ) {}
  async compile(input: Project, revisionId: string): Promise<BuildResult> {
    const start = performance.now();
    const before = { ...this.cache.stats };
    let currentFile = input.entry;
    try {
      await this.initialize();
      const initialized = performance.now();
      const project = structuredClone(input);
      const existingLock = project.lock;
      project.lock = {};
      if (Object.keys(project.files).length > 512)
        throw new Error("Projects are limited to 512 source files.");
      for (const path of Object.keys(project.files))
        if (
          normalizePath(path) !== path ||
          path.startsWith("/") ||
          isRemote(path)
        )
          throw new Error(`Invalid project path: ${path}`);
      const entry = resolveLocal(project.entry, project);
      const modules: Record<string, CompiledModule> = Object.create(
        null,
      ) as Record<string, CompiledModule>;
      const visited = new Set<string>();
      const css: string[] = [];
      let transformedModules = 0;
      const dependencies = JSON.stringify([
        project.dependencies,
        Object.keys(project.files).sort(),
      ]);
      const read = async (id: string): Promise<Uint8Array> => {
        if (!isRemote(id)) {
          const source = project.files[id];
          if (source === undefined)
            throw new Error(`Missing project file ${id}`);
          if (source.length > 2 * 1024 * 1024)
            throw new Error(`Source file exceeds 2 MiB: ${id}`);
          return encoder.encode(source);
        }
        if (new URL(id).origin !== "https://esm.sh")
          throw new Error(`Unsupported dependency origin: ${id}`);
        const bytes = await this.cache.read(id);
        const integrity = await digest(bytes);
        const locked = existingLock[id];
        if (locked && locked.integrity !== integrity)
          throw new Error(
            `Integrity mismatch for ${id}. The locked dependency has changed; explicitly remove its lock to upgrade.`,
          );
        project.lock[id] = { url: id, integrity };
        return bytes;
      };
      const asset = async (id: string): Promise<string> => {
        const extension = id.split("?")[0]!.split(".").at(-1)!;
        return dataUrl(
          await read(id),
          assetMimes[extension] ?? "application/octet-stream",
        );
      };
      const load = async (id: string): Promise<void> => {
        if (PLATFORM_MODULES.has(id) || visited.has(id)) return;
        visited.add(id);
        if (visited.size > 1024)
          throw new Error(
            "Dependency graph exceeds 1024 modules. Choose a smaller browser package.",
          );
        currentFile = id;
        const bytes = await read(id);
        const source = decoder.decode(bytes);
        const extension = id.split("?")[0]!.split(".").at(-1);
        if (extension === "css") {
          if (id.includes(".module.css"))
            throw new Error(
              "CSS modules are not supported yet; use ordinary stylesheets and className.",
            );
          let content = source;
          for (const match of [
            ...content.matchAll(
              /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/g,
            ),
          ]) {
            const imported = match[1]!;
            await load(
              resolveModule(
                imported.startsWith(".") ||
                  imported.startsWith("/") ||
                  isRemote(imported)
                  ? imported
                  : `./${imported}`,
                id,
                project,
              ),
            );
            content = content.replace(match[0], "");
          }
          if (/@import\b/i.test(content))
            throw new Error(
              "Conditional CSS @import is not supported; import the stylesheet directly from a source module.",
            );
          for (const match of [
            ...content.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/g),
          ]) {
            if (/^(data:|#)/.test(match[1]!)) continue;
            const assetId = resolveModule(
              match[1]!.startsWith(".") ||
                match[1]!.startsWith("/") ||
                isRemote(match[1]!)
                ? match[1]!
                : `./${match[1]!}`,
              id,
              project,
            );
            content = content.replace(
              match[0],
              `url("${await asset(assetId)}")`,
            );
          }
          css.push(content);
          modules[id] = {
            code: "module.exports = {};",
            hash: await digest(bytes),
          };
          return;
        }
        if (extension && Object.hasOwn(assetMimes, extension)) {
          const code = `module.exports = ${JSON.stringify(dataUrl(bytes, assetMimes[extension]!))};`;
          modules[id] = { code, hash: await digest(bytes) };
          return;
        }
        if (extension === "json") {
          const code = `module.exports = ${JSON.stringify(JSON.parse(source))};`;
          modules[id] = { code, hash: await digest(bytes) };
          return;
        }
        const previous = this.transforms.get(id);
        let compiled = previous;
        if (
          !previous ||
          previous.source !== source ||
          previous.dependencies !== dependencies
        ) {
          const result = compileModule(source, id, (specifier) =>
            resolveModule(specifier, id, project),
          );
          compiled = {
            source,
            dependencies,
            ...result,
            hash: await digest(encoder.encode(result.code)),
          };
          this.transforms.set(id, compiled);
          transformedModules++;
          if (this.transforms.size > 512)
            this.transforms.delete(this.transforms.keys().next().value!);
        }
        modules[id] = { code: compiled!.code, hash: compiled!.hash };
        for (const imported of compiled!.imports) await load(imported);
      };
      await load(entry);
      const end = performance.now();
      return {
        ok: true,
        project,
        artifact: {
          entry,
          modules,
          css: css.join("\n"),
          revisionId,
          metrics: {
            initializationMs: initialized - start,
            compileMs: end - initialized,
            totalMs: end - start,
            transformedModules,
            moduleCount: Object.keys(modules).length,
            networkRequests:
              this.cache.stats.networkRequests - before.networkRequests,
            cacheHits: this.cache.stats.cacheHits - before.cacheHits,
            bytesDownloaded:
              this.cache.stats.bytesDownloaded - before.bytesDownloaded,
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            file: currentFile,
            message: String(
              error instanceof Error ? error.message : error,
            ).replace(/\u001b\[[0-9;]*m/g, ""),
          },
        ],
      };
    }
  }
}
