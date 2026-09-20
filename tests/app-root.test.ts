// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ensureCanonicalAppRoot, enforceCanonicalAppRootAfterAgentCommand } from "../src/runtime/app-root";

describe("canonical app root", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("creates one canonical root and discards visible UI outside it", () => {
    document.body.innerHTML = `
      <main data-outside-app>Outside app</main>
      <script data-app-runtime></script>
    `;

    const root = ensureCanonicalAppRoot();

    expect(root.id).toBe("itsalive-root");
    expect(document.querySelector("[data-outside-app]")).toBeNull();
    expect(document.querySelectorAll('[id="itsalive-root"]')).toHaveLength(1);
    expect(document.querySelector("[data-app-runtime]")?.parentElement).toBe(document.body);
  });

  it("rejects and removes a second top-level app surface without disturbing the existing app", () => {
    document.body.innerHTML = '<main id="itsalive-root"><section data-working>Working app</section></main>';
    const root = document.getElementById("itsalive-root");
    document.body.insertAdjacentHTML("beforeend", '<main data-duplicate-app>Duplicate app</main>');

    expect(() => enforceCanonicalAppRootAfterAgentCommand()).toThrow(/outside #itsalive-root/);
    expect(document.querySelector("[data-duplicate-app]")).toBeNull();
    expect(document.querySelector("[data-working]")).toBeTruthy();
    expect(document.getElementById("itsalive-root")).toBe(root);
  });

  it("recreates the canonical root and discards output from a full body replacement", () => {
    document.body.innerHTML = '<main data-rebuilt>Rebuilt app</main>';

    expect(() => enforceCanonicalAppRootAfterAgentCommand()).toThrow(/preserve exactly one direct #itsalive-root/);
    expect(document.getElementById("itsalive-root")).toBeTruthy();
    expect(document.querySelector("[data-rebuilt]")).toBeNull();
  });
});
