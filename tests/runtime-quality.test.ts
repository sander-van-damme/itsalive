import { describe, expect, it } from "vitest";
import { contrastRatio, parseComputedColor } from "../src/runtime/quality";

describe("computed contrast evidence", () => {
  it("parses browser RGB and alpha syntax without pretending unsupported color spaces are RGB", () => {
    expect(parseComputedColor("rgb(12, 34, 56)")).toEqual([12, 34, 56, 1]);
    expect(
      parseComputedColor("rgb(100% 0% 0% / 50%)")?.map(
        (value) => Math.round(value * 100) / 100,
      ),
    ).toEqual([255, 0, 0, 0.5]);
    expect(parseComputedColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseComputedColor("rgb(bad)")).toBeNull();
  });
  it("uses WCAG relative luminance rather than color-channel distance", () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBe(21);
    expect(contrastRatio([255, 255, 255, 1], [255, 255, 255, 1])).toBe(1);
    expect(contrastRatio([170, 170, 170, 1], [255, 255, 255, 1])).toBeCloseTo(
      2.323,
      3,
    );
  });
});
