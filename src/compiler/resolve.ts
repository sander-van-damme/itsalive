import type { Project } from "../shared/types";

export const PLATFORM_MODULES = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "zustand",
  "zustand/vanilla",
  "zustand/middleware",
  "@itsalive/ai",
  "@itsalive/store",
]);
const BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "http",
  "https",
  "net",
  "tls",
  "child_process",
  "worker_threads",
  "stream",
  "buffer",
  "util",
  "events",
  "zlib",
  "dns",
  "module",
  "process",
  "url",
  "vm",
  "assert",
  "tty",
  "readline",
  "perf_hooks",
]);
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") {
      if (!parts.length) throw new Error("Import escapes the project root");
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function isRemote(path: string): boolean {
  return /^https:\/\//.test(path);
}
export function resolveLocal(path: string, project: Project): string {
  const clean = normalizePath(path);
  for (const candidate of [
    clean,
    ...[
      ".tsx",
      ".ts",
      ".jsx",
      ".js",
      ".json",
      "/index.tsx",
      "/index.ts",
      "/index.jsx",
      "/index.js",
    ].map((extension) => clean + extension),
  ]) {
    if (Object.hasOwn(project.files, candidate)) return candidate;
  }
  throw new Error(
    `Cannot resolve project file "${path}". Create the file or correct its import path.`,
  );
}
/** CDN package graphs may reference framework packages by URL. Keep one runtime identity. */
export function runtimeModuleForUrl(url: string): string | null {
  const match = new URL(url).pathname.match(
    /^\/(?:(?:v\d+|stable)\/)?(react-dom|react|zustand)@([^/]+)(?:\/(.*))?$/,
  );
  if (!match) return null;
  const name = match[1]!;
  const version = decodeURIComponent(match[2]!);
  const expectedMajor = name === "zustand" ? 5 : 19;
  if (
    /^\d+\.\d+\.\d+/.test(version) &&
    Number(version.split(".")[0]) !== expectedMajor
  ) {
    throw new Error(
      `Dependency requests ${name}@${version}; the stable runtime provides ${name} ${expectedMajor}. Select a compatible package version.`,
    );
  }
  const last = (match[3] ?? "")
    .split("/")
    .at(-1)!
    .replace(/(?:\.development|\.production)?\.m?js$/, "");
  const resolved = !last || last === name ? name : `${name}/${last}`;
  if (!PLATFORM_MODULES.has(resolved))
    throw new Error(
      `Unsupported runtime package subpath ${resolved}. Use a browser-compatible React entry.`,
    );
  return resolved;
}
export function resolveModule(
  specifier: string,
  importer: string,
  project: Project,
): string {
  if (PLATFORM_MODULES.has(specifier)) return specifier;
  if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!)) {
    throw new Error(
      `"${specifier}" requires Node.js APIs. Generated applications run in browsers; use a browser-compatible package or browser API.`,
    );
  }
  if (
    isRemote(importer) &&
    (specifier.startsWith("/") || specifier.startsWith("."))
  ) {
    const resolved = new URL(specifier, importer).href;
    if (resolved.includes("/node/") || resolved.includes("/node."))
      throw new Error(
        `Dependency ${importer} requires a Node.js polyfill (${specifier}); select a browser-native alternative.`,
      );
    return runtimeModuleForUrl(resolved) ?? resolved;
  }
  if (specifier.startsWith("."))
    return resolveLocal(
      `${importer.slice(0, importer.lastIndexOf("/") + 1)}${specifier}`,
      project,
    );
  if (specifier.startsWith("/")) return resolveLocal(specifier, project);
  if (isRemote(specifier)) {
    if (new URL(specifier).origin !== "https://esm.sh")
      throw new Error(
        "Module URLs must use the esm.sh dependency gateway; ordinary browser fetch remains available inside apps.",
      );
    return runtimeModuleForUrl(specifier) ?? specifier;
  }
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  const version = project.dependencies[name];
  if (!version)
    throw new Error(
      `Dependency "${name}" is not declared. Add an exact version to project.dependencies.`,
    );
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error(
      `Dependency "${name}" must use an exact version (for example 1.2.3), not "${version}".`,
    );
  const subpath = specifier.slice(name.length);
  return `https://esm.sh/${name}@${version}${subpath}?target=es2022`;
}
