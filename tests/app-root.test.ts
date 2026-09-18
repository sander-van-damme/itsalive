// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ensureCanonicalAppRoot, enforceCanonicalAppRootAfterAgentCommand } from "../src/app/app-root";

describe("canonical app root", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("migrates restored rootless UI into one canonical root while leaving runtime-owned nodes outside", () => {
    document.body.innerHTML = `
      <main data-legacy-app>Legacy app</main>
      <itsalive-history hidden><itsalive-history-summary>summary</itsalive-history-summary></itsalive-history>
      <script data-app-runtime></script>
    `;

    const root = ensureCanonicalAppRoot();

    expect(root.id).toBe("itsalive-root");
    expect(root.querySelector("[data-legacy-app]")).toBeTruthy();
    expect(document.querySelectorAll('[id="itsalive-root"]')).toHaveLength(1);
    expect(document.querySelector("itsalive-history")?.parentElement).toBe(document.body);
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

  it("recovers visible output into a new canonical root when a command replaces the body", () => {
    document.body.innerHTML = '<main data-rebuilt>Rebuilt app</main>';

    expect(() => enforceCanonicalAppRootAfterAgentCommand()).toThrow(/preserve exactly one direct #itsalive-root/);
    const root = document.getElementById("itsalive-root");
    expect(root).toBeTruthy();
    expect(root?.querySelector("[data-rebuilt]")).toBeTruthy();
  });
});
