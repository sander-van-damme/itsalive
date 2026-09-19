import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("wildcard bootstrap architecture", () => {
  it("keeps permanent src/app code to the bootstrap entry only", () => {
    expect(readdirSync(resolve(root, "src/app")).sort()).toEqual(["main.ts"]);
    const bootstrap = readFileSync(resolve(root, "src/app/main.ts"), "utf8");
    expect(bootstrap).toContain("createBootstrapReady");
    expect(bootstrap).toContain("isBootstrapInitMessage");
    expect(bootstrap).toContain("event.origin !== root");
    expect(bootstrap).toContain("event.source !== window.parent");
    expect(bootstrap).toContain("new Function");
  });

  it("routes only the destructive cleanup path through the wildcard worker", () => {
    const wrangler = readFileSync(resolve(root, "wrangler.app.toml"), "utf8");
    expect(wrangler).toContain('main = "src/app-worker.ts"');
    expect(wrangler).toContain('binding = "ASSETS"');
    expect(wrangler).toContain('run_worker_first = ["/__clear"]');
  });

  it("keeps platform runtime and library policy out of the wildcard static page", () => {
    const html = readFileSync(resolve(root, "sites/app/index.html"), "utf8");
    expect(html).not.toContain("cdnjs.cloudflare.com");
    expect(html.match(/data-app-runtime/g)).toHaveLength(1);
    expect(html).toContain('data-app-runtime type="module" src="./main.ts"');
    expect(html.length).toBeLessThan(2_000);

    const runtimeFiles = readdirSync(resolve(root, "src/runtime"));
    expect(runtimeFiles).toEqual(expect.arrayContaining([
      "assets.ts",
      "components.ts",
      "interactions.ts",
      "persistence.ts",
      "runtime.ts",
      "screenshot.ts",
    ]));
    expect(runtimeFiles).not.toContain("db.ts");
    expect(runtimeFiles).not.toContain("storage.ts");
  });
});
