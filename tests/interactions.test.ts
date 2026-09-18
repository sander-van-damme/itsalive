// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInteractionObserver } from "../src/app/interactions";
import { serializeSemanticDocument } from "../src/app/semantic-document";
import { ReactionBatcher, formatReactionBatch } from "../src/shell/core/reactions";
import { MockDecisionModel } from "../src/shell/core/jev";
import { MAX_SEMANTIC_DOCUMENT_CHARACTERS, type AppToShellPayload, type JevState } from "../src/shared";

const response = (probability: number) => Promise.resolve({ type: "jev.response", probability, escalated: probability >= .7 });

describe("continuous interaction observation", () => {
  afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; vi.useRealTimers(); });

  it("observes delegated UI without writing raw interaction records into HTML", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    const component = document.createElement("music-card");
    const button = document.createElement("button");
    const callback = vi.fn();
    button.addEventListener("click", callback);
    component.append(button);
    document.body.append(component);

    button.click();
    await Promise.resolve();

    expect(callback).toHaveBeenCalledOnce();
    expect(document.querySelector("itsalive-interaction")).toBeNull();
    const payload = request.mock.calls[0]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(payload.state.interaction.target.tag).toBe("music-card");
    expect(payload.state.interaction.actualTarget.tag).toBe("button");
    expect(payload.state.recentInteractions).toHaveLength(1);
    observer.destroy();
  });

  it("uses ordinary semantic containers as behavioral targets", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    document.body.innerHTML = `<section data-component="tempo"><button>Faster</button></section>`;
    document.querySelector("button")!.click();
    await Promise.resolve();

    const payload = request.mock.calls[0]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(payload.state.interaction.target).toMatchObject({ tag: "section" });
    observer.destroy();
  });

  it("never exposes password values to Jev state or persisted history", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    const input = document.createElement("input");
    input.type = "password";
    input.value = "super-secret";
    document.body.append(input);
    input.click();
    await Promise.resolve();

    expect(JSON.stringify(request.mock.calls[0]?.[0])).not.toContain("super-secret");
    expect(document.documentElement.outerHTML).not.toContain("super-secret");
    expect(document.querySelector("itsalive-history")?.textContent).toBe("");
    observer.destroy();
  });

  it("serializes semantic state while removing implementation noise", () => {
    document.head.innerHTML = `<style>.secret{}</style><script>danger()</script>`;
    document.body.innerHTML = `<violin-metronome bpm="92" running><div class="flex px-4 shadow-xl">Tempo</div><input value="100"></violin-metronome>`;
    const result = serializeSemanticDocument();
    expect(result).toContain('<violin-metronome bpm="92" running="">');
    expect(result).toContain("Tempo");
    expect(result).toContain('value="100"');
    expect(result).not.toContain("danger");
    expect(result).not.toContain("shadow-xl");
  });

  it("migrates legacy raw history away and keeps only the curated summary", () => {
    document.body.innerHTML = `<main>Current app</main><itsalive-history><itsalive-history-summary>likes violins</itsalive-history-summary><itsalive-interaction value="old raw"></itsalive-interaction></itsalive-history>`;
    const observer = installInteractionObserver({ request: vi.fn() } as never, { acceptUntrustedForTest: true });

    expect(document.querySelector("itsalive-history-summary")?.textContent).toBe("likes violins");
    expect(document.querySelector("itsalive-interaction")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("old raw");
    const semantic = serializeSemanticDocument();
    expect(semantic).toContain("Current app");
    expect(semantic).not.toContain("likes violins");
    expect(semantic).not.toContain("itsalive-history");
    observer.destroy();
  });

  it("preserves one canonical curated history across body rewrites until teardown", async () => {
    document.body.innerHTML = `<itsalive-history hidden><itsalive-history-summary>prefers 90 bpm</itsalive-history-summary></itsalive-history>`;
    const original = document.querySelector("itsalive-history")!;
    const observer = installInteractionObserver({ request: vi.fn() } as never, { acceptUntrustedForTest: true });

    document.body.innerHTML = "<main>New app</main>";
    await vi.waitFor(() => expect(document.querySelector("itsalive-history")).toBe(original));
    expect(document.querySelector("itsalive-history-summary")?.textContent).toBe("prefers 90 bpm");

    document.body.innerHTML += "<itsalive-history><itsalive-history-summary>duplicate</itsalive-history-summary></itsalive-history>";
    await vi.waitFor(() => expect(document.querySelectorAll("itsalive-history")).toHaveLength(1));
    expect(document.querySelector("itsalive-history")).toBe(original);

    observer.destroy();
    document.body.replaceChildren(document.createElement("main"));
    await Promise.resolve();
    expect(document.querySelector("itsalive-history")).toBeNull();
  });

  it("sends bounded target metadata and keyboard keys without persisting them", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    document.body.insertAdjacentHTML("beforeend", `<section data-component="settings" id="sound" aria-label="Sound settings" data-state="editing"><input id="enabled" aria-label="Enabled" data-state="on" type="checkbox" value="safe" checked></section>`);
    document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await Promise.resolve();

    const payload = request.mock.calls[0]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(payload.state.interaction).toMatchObject({
      key: "Enter",
      target: { tag: "section", id: "sound", state: { "aria-label": "Sound settings", "data-state": "editing" } },
      actualTarget: { tag: "input", id: "enabled", value: "safe", state: { "aria-label": "Enabled", "data-state": "on", checked: true } },
    });
    expect(document.querySelector("itsalive-interaction")).toBeNull();
    observer.destroy();
  });

  it("persists only an LLM-rewritten curated history", async () => {
    const request = vi.fn(async (payload: AppToShellPayload) => payload.type === "llm.request"
      ? { type: "llm.response", result: "User repeatedly adjusts tempo upward and prefers quick feedback." }
      : { type: "jev.response", probability: .1, escalated: false });
    const button = document.body.appendChild(document.createElement("button"));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, historyRewriteInterval: 3 });

    for (let index = 0; index < 3; index++) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("itsalive-history-summary")?.textContent).toContain("adjusts tempo"));

    expect(document.querySelectorAll("itsalive-interaction")).toHaveLength(0);
    const llmRequest = request.mock.calls.map(call => call[0]).find(payload => payload.type === "llm.request") as Extract<AppToShellPayload, { type: "llm.request" }>;
    expect(llmRequest.prompt).toContain("Rewrite the behavioral history");
    expect(llmRequest.prompt).toContain("New ephemeral interactions");
    observer.destroy();
  });
});

describe("semantic document bounds", () => {
  afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

  it("emits parseable, explicitly truncated HTML within the shared character limit", () => {
    document.body.innerHTML = `<main><h1>Important early content 🚀</h1>${Array.from({ length: 2_500 }, (_, index) => `<article id="item-${index}">${"界".repeat(100)}</article>`).join("")}</main>`;
    const result = serializeSemanticDocument();
    expect(result.length).toBeLessThanOrEqual(MAX_SEMANTIC_DOCUMENT_CHARACTERS);
    expect(result).toContain("Important early content 🚀");
    const parsed = new DOMParser().parseFromString(result, "text/html");
    expect(parsed.documentElement.getAttribute("data-semantic-truncated")).toBe("true");
    expect(parsed.querySelector("parsererror")).toBeNull();
  });

  it("does not mark a small complete projection as truncated", () => {
    document.body.innerHTML = "<main>Hello</main>";
    expect(serializeSemanticDocument()).not.toContain("data-semantic-truncated");
  });
});

describe("Jev decisions and reaction batching", () => {
  const state = (seq: number): JevState => ({
    interaction: { seq, at: "2026-01-01T00:00:00Z", type: "click", target: { tag: "section" }, actualTarget: { tag: "button" } },
    recentInteractions: [],
    document: "<html><body><section></section></body></html>",
  });

  it("supports deterministic negative and positive mock decisions", async () => {
    await expect(new MockDecisionModel(() => .2).evaluate({ state: state(1) })).resolves.toMatchObject({ probability: .2 });
    await expect(new MockDecisionModel(() => .9).evaluate({ state: state(2) })).resolves.toMatchObject({ probability: .9 });
  });

  it("coalesces nearby positive interactions and tears down timers", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = new ReactionBatcher(deliver, 100);
    batcher.add(state(1));
    batcher.add(state(2));
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0].events).toHaveLength(2);
    batcher.add(state(3));
    batcher.destroy();
    await vi.runAllTimersAsync();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("orders concurrent results by sequence and selects the newest document", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = new ReactionBatcher(deliver, 10);
    batcher.add({ ...state(8), document: "newest" });
    batcher.add({ ...state(3), document: "older" });
    await vi.advanceTimersByTimeAsync(10);
    const batch = deliver.mock.calls[0]![0];
    expect(batch.events.map((event: JevState) => event.interaction.seq)).toEqual([3, 8]);
    expect(formatReactionBatch(batch)).toContain("newest");
    expect(formatReactionBatch(batch).endsWith("newest")).toBe(true);
  });
});

describe("privacy and bounded work", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("ignores synthetic clicks in production while preserving the callback", async () => {
    const request = vi.fn();
    const callback = vi.fn();
    const button = document.body.appendChild(document.createElement("button"));
    button.onclick = callback;
    const observer = installInteractionObserver({ request } as never);
    button.click();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector("itsalive-interaction")).toBeNull();
    observer.destroy();
  });

  it("redacts password keydown contents and secret custom attributes and URLs", async () => {
    const request = vi.fn((payload: unknown) => { void payload; return response(.1); });
    document.body.innerHTML = `<account-card api-token="abc123" href="https://bob:hunter@example.com/go?token=qwerty&ok=1"><input type="password" name="credential" value="super-secret"></account-card>`;
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true });
    document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, composed: true }));
    await Promise.resolve();
    const serialized = JSON.stringify(request.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain('"key":"s"');
    const semantic = serializeSemanticDocument();
    expect(semantic).not.toContain("abc123");
    expect(semantic).not.toContain("hunter");
    expect(semantic).not.toContain("qwerty");
    expect(semantic).toContain("%5Bredacted%5D");
    observer.destroy();
  });

  it("coalesces saturated Jev work to the freshest interaction", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const request = vi.fn((payload: unknown) => { void payload; return new Promise(resolve => resolvers.push(resolve)); });
    const button = document.body.appendChild(document.createElement("button"));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, maxInFlight: 1, historyRewriteInterval: 40 });
    for (let index = 0; index < 4; index++) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(request).toHaveBeenCalledOnce();
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const latest = request.mock.calls[1]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(latest.state.interaction.seq).toBe(4);
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false });
    observer.destroy();
  });
});
