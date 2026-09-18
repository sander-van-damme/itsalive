// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInteractionObserver } from "../src/app/interactions";
import { serializeSemanticDocument } from "../src/app/semantic-document";
import { ReactionBatcher, formatReactionBatch } from "../src/shell/core/reactions";
import { MockDecisionModel } from "../src/shell/core/jev";
import type { AppToShellPayload, JevState } from "../src/shared";

const response = (probability: number) => Promise.resolve({ type: "jev.response", probability, escalated: probability >= .7 });

describe("continuous interaction observation", () => {
  afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; vi.useRealTimers(); });

  it("delegates newly inserted custom elements without suppressing normal callbacks", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
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
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); }); const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
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

  it("does not embed platform raw history in semantic snapshots", () => {
    document.body.innerHTML = `<main>Current app</main><itsalive-history><itsalive-history-summary>likes violins</itsalive-history-summary><itsalive-interaction value="old raw"></itsalive-interaction></itsalive-history>`;
    const result = serializeSemanticDocument(); expect(result).toContain("Current app"); expect(result).not.toContain("old raw"); expect(result).not.toContain("itsalive-history");
  });

  it("restores sequence from persisted HTML and removes listeners on teardown", async () => {
    document.body.innerHTML = `<itsalive-history hidden><itsalive-interaction seq="9"></itsalive-interaction></itsalive-history><new-card><button>go</button></new-card>`;
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); }); const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
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
  it("orders concurrent results by sequence and selects the newest document", async () => {
    vi.useFakeTimers(); const deliver = vi.fn(); const batcher = new ReactionBatcher(deliver, 10);
    batcher.add({ ...state(8), document: "newest" }); batcher.add({ ...state(3), document: "older" }); await vi.advanceTimersByTimeAsync(10);
    const batch = deliver.mock.calls[0]![0]; expect(batch.events.map((event: JevState) => event.interaction.seq)).toEqual([3, 8]);
    expect(formatReactionBatch(batch)).toContain("newest"); expect(formatReactionBatch(batch).endsWith("newest")).toBe(true);
  });
});

describe("privacy and trust regressions", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  it("ignores synthetic clicks in production while preserving the callback", async () => {
    const request = vi.fn(); const callback = vi.fn();
    const button = document.body.appendChild(document.createElement("button")); button.onclick = callback;
    const observer = installInteractionObserver({ request } as never); button.click(); await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(document.querySelector("itsalive-interaction")).toBeNull(); observer.destroy();
  });
  it("redacts password keydown contents and secret custom attributes and URLs", async () => {
    const request = vi.fn((payload: unknown) => { void payload; return response(.1); });
    document.body.innerHTML = `<account-card api-token="abc123" href="https://bob:hunter@example.com/go?token=qwerty&ok=1"><input type="password" name="credential" value="super-secret"></account-card>`;
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, composed: true })); await Promise.resolve();
    const serialized = JSON.stringify(request.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("super-secret"); expect(serialized).not.toContain('"key":"s"');
    const semantic = serializeSemanticDocument(); expect(semantic).not.toContain("abc123"); expect(semantic).not.toContain("hunter"); expect(semantic).not.toContain("qwerty"); expect(semantic).toContain("%5Bredacted%5D"); observer.destroy();
  });
});

describe("bounded observation work", () => {
  afterEach(() => { document.body.innerHTML = ""; });
  it("coalesces saturated Jev work to the freshest interaction", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const request = vi.fn((payload: unknown) => { void payload; return new Promise(resolve => resolvers.push(resolve)); });
    const button = document.body.appendChild(document.createElement("button"));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, maxInFlight: 1, historyRawLimit: 100 });
    for (let index = 0; index < 4; index++) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(request).toHaveBeenCalledOnce();
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false }); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const latest = request.mock.calls[1]![0] as Extract<AppToShellPayload, { type: "jev.request" }>; expect(latest.state.interaction.seq).toBe(4);
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false }); observer.destroy();
  });

  it("compacts old history only after a successful trusted LLM response", async () => {
    const request = vi.fn(async (payload: AppToShellPayload) => payload.type === "llm.request" ? { type: "llm.response", result: "User repeatedly adjusts tempo." } : { type: "jev.response", probability: .1, escalated: false });
    const button = document.body.appendChild(document.createElement("button"));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, historyRawLimit: 13 });
    for (let index = 0; index < 13; index++) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("itsalive-history-summary")?.textContent).toContain("adjusts tempo"));
    expect(document.querySelectorAll("itsalive-interaction")).toHaveLength(12); observer.destroy();
  });
});
