import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const output = resolve("work/connection/companion.mjs");
await build({
  entryPoints: ["src/server/companion.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
const { createCompanion } = await import(pathToFileURL(output).href);
const helper = await createCompanion();
await helper.listen();
console.log(
  "The It’s Alive connection helper is ready. Return to Settings and select Continue with ChatGPT.",
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => helper.server.close(() => process.exit(0)));
