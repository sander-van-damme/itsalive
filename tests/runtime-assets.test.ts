import { describe, expect, it } from "vitest";
import { BUILDING_STYLE } from "../src/runtime/assets";

describe("component-scoped build treatment", () => {
  it("uses quiet region state styling without the old Building label or frosted pulse", () => {
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="queued"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="building"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="failed"');
    expect(BUILDING_STYLE).toContain('data-itsalive-build-state="blocked"');
    expect(BUILDING_STYLE).not.toContain('content: "Building…"');
    expect(BUILDING_STYLE).not.toContain('backdrop-filter');
    expect(BUILDING_STYLE).not.toContain('@keyframes');
  });

  it("explicitly disables motion for reduced-motion users", () => {
    expect(BUILDING_STYLE).toContain("prefers-reduced-motion: reduce");
    expect(BUILDING_STYLE).toContain("animation: none !important");
    expect(BUILDING_STYLE).toContain("transition: none !important");
  });
});
