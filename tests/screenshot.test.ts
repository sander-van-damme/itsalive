// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { formatScreenshotUnavailable, sanitizeScreenshotClone } from "../src/runtime/screenshot";

describe("screenshot fallback sanitization", () => {
  it("removes external resource loads while preserving ordinary markup", () => {
    const clone = document.createElement("main");
    clone.innerHTML = `
      <script src="https://example.com/app.js"></script>
      <link rel="stylesheet" href="https://example.com/app.css">
      <style>.hero{background-image:url("https://example.com/bg.png")}.safe{background-image:url("data:image/png;base64,AA==")}</style>
      <img src="https://example.com/photo.png" srcset="https://example.com/photo@2x.png 2x" alt="photo">
      <div style="background:url(https://example.com/tile.png)">Hello</div>
    `;

    sanitizeScreenshotClone(clone);

    expect(clone.querySelector("script")).toBeNull();
    expect(clone.querySelector("link")).toBeNull();
    expect(clone.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(clone.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    expect(clone.innerHTML).not.toContain("https://example.com");
    expect(clone.innerHTML).toContain("data:image/png;base64,AA==");
    expect(clone.textContent).toContain("Hello");
  });

  it("returns a compact explicit unavailable marker", () => {
    const result = formatScreenshotUnavailable(new Error("canvas export blocked"));
    expect(result).toBe("[screenshot unavailable: canvas export blocked]");
  });
});
