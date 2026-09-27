import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILDING_STYLE, TAILWIND_BROWSER_ASSET, installRuntimeAssets } from "../src/runtime/assets";

describe("component-scoped build treatment", () => {
  it("keeps only pinned Tailwind Browser as the default third-party runtime asset", () => {
    const source = readFileSync(new URL("../src/runtime/assets.ts", import.meta.url), "utf8");
    expect(TAILWIND_BROWSER_ASSET.url).toContain("tailwindcss-browser/4.3.3");
    expect(TAILWIND_BROWSER_ASSET.integrity).toMatch(/^sha512-/);
    for (const removed of [
      "feather-icons", "Chart.js", "d3/", "three.js", "marked/", "mermaid/",
      "mathjs", "dayjs", "Swiper", "leaflet", "KaTeX", "gsap", "PapaParse",
      "fuzzysort", "highlight.js", "alpinejs",
    ]) expect(source, removed).not.toContain(removed);
    expect(source).not.toContain("[x-cloak]");
  });

  it("installs Tailwind once and keeps runtime build styling local", async () => {
    const install = installRuntimeAssets(document);
    const script = document.querySelector<HTMLScriptElement>(
      `script[data-itsalive-runtime-asset="${TAILWIND_BROWSER_ASSET.url}"]`,
    );
    expect(script).not.toBeNull();
    expect(script?.src).toBe(TAILWIND_BROWSER_ASSET.url);
    expect(script?.integrity).toBe(TAILWIND_BROWSER_ASSET.integrity);
    expect(document.querySelector("style[data-itsalive-runtime-style]")).not.toBeNull();
    script!.dispatchEvent(new Event("load"));
    await install;

    await installRuntimeAssets(document);
    expect(document.querySelectorAll(`script[data-itsalive-runtime-asset="${TAILWIND_BROWSER_ASSET.url}"]`)).toHaveLength(1);
    expect(document.querySelectorAll("style[data-itsalive-runtime-style]")).toHaveLength(1);
  });

  it("uses quiet region state styling without the old Building label or frosted pulse", () => {
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="queued"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="building"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="failed"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="blocked"');
    expect(BUILDING_STYLE).not.toContain('content: "Building…"');
    expect(BUILDING_STYLE).not.toContain('backdrop-filter');
    expect(BUILDING_STYLE).not.toContain('@keyframes');
    expect(BUILDING_STYLE).toContain('pointer-events: none');
  });

  it("uses disposable non-technical copy for the app bootstrap", () => {
    const source = readFileSync(new URL("../sites/app/index.html", import.meta.url), "utf8");
    expect(source).toContain("data-itsalive-bootstrap");
    expect(source).toContain("Preparing your app…");
    expect(source).not.toContain("itsalive shell");
    expect(source).not.toContain("Connecting to the");
  });

  it("explicitly disables motion for reduced-motion users", () => {
    expect(BUILDING_STYLE).toContain("prefers-reduced-motion: reduce");
    expect(BUILDING_STYLE).toContain("animation: none !important");
    expect(BUILDING_STYLE).toContain("transition: none !important");
  });
});
