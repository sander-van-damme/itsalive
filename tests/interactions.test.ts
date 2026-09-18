// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInteractionObserver } from "../src/app/interactions";
import { serializeSemanticDocument } from "../src/app/semantic-document";
import { ReactionBatcher } from "../src/shell/core/reactions";
import { MockDecisionModel } from "../src/shell/core/jev";
import type { AppToShellPayload, JevState } from "../src/shared";

const response = (probability: number) => Promise.resolve({ type: "jev.response", probability, escalated: probability >= .7 });

describe("continuous interaction observation", () => {
  afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; vi.useRealTimers(); });

  it("delegates newly inserted custom elements without suppressing normal callbacks", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never);
    const component = document.createElement("music-card");
    const button = document.createElement("button");
    const callback = vi.fn(); button.addEventListener("click", callback); component.append(button); document.body.append(component);
    button.click(); await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    expect(document.querySelector("itsalive-interaction")).toMatchObject({ localName: "itsalive-interaction" });
    expect(document.querySelector("itsalive-interaction")?.getAttribute("target")).toBe("music-card");
    const payload = request.mock.calls[0]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(payload.state.interaction.actualTarget.tag).toBe("button");
    observer.destroy();
  });

  it("never writes password values to history or Jev state", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); }); const observer = installInteractionObserver({ request } as never);
    const input = document.createElement("input"); input.type = "password"; input.value = "super-secret"; document.body.append(input);
    input.click(); await Promise.resolve();
    expect(document.querySelector("itsalive-interaction")?.outerHTML).not.toContain("super-secret");
    expect(JSON.stringify(request.mock.calls[0]?.[0])).not.toContain("super-secret");
    observer.destroy();
  });

  it("serializes semantic state while removing implementation noise", () => {
    document.head.innerHTML = `<style>.secret{}</style><script>danger()</script>`;
    document.body.innerHTML = `<violin-metronome bpm="92" running><div class="flex px-4 shadow-xl">Tempo</div><input value="100"></violin-metronome>`;
    const result = serializeSemanticDocument();
    expect(result).toContain('<violin-metronome bpm="92" running="">');
    expect(result).toContain("Tempo"); expect(result).toContain('value="100"');
    expect(result).not.toContain("danger"); expect(result).not.toContain("shadow-xl");
  });

  it("restores sequence from persisted HTML and removes listeners on teardown", async () => {
    document.body.innerHTML = `<itsalive-history hidden><itsalive-interaction seq="9"></itsalive-interaction></itsalive-history><new-card><button>go</button></new-card>`;
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); }); const observer = installInteractionObserver({ request } as never);
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); await Promise.resolve();
    expect(document.querySelectorAll("itsalive-interaction")[1]?.getAttribute("seq")).toBe("10");
    observer.destroy(); document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("Jev decisions and reaction batching", () => {
  const state = (seq: number): JevState => ({ interaction: { seq, at: "2026-01-01T00:00:00Z", type: "click", target: { tag: "x-card" }, actualTarget: { tag: "button" } }, recentInteractions: [], document: "<html><body><x-card></x-card></body></html>" });
  it("supports deterministic negative and positive mock decisions", async () => {
    await expect(new MockDecisionModel(() => .2).evaluate({ state: state(1) })).resolves.toMatchObject({ probability: .2 });
    await expect(new MockDecisionModel(() => .9).evaluate({ state: state(2) })).resolves.toMatchObject({ probability: .9 });
  });
  it("coalesces nearby positive interactions and tears down timers", async () => {
    vi.useFakeTimers(); const deliver = vi.fn(); const batcher = new ReactionBatcher(deliver, 100);
    batcher.add(state(1)); batcher.add(state(2)); await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledOnce(); expect(deliver.mock.calls[0]?.[0].events).toHaveLength(2);
    batcher.add(state(3)); batcher.destroy(); await vi.runAllTimersAsync(); expect(deliver).toHaveBeenCalledOnce();
  });
});
