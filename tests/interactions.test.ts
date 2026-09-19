// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInteractionObserver } from "../src/runtime/interactions";
import { serializeSemanticDocument } from "../src/runtime/semantic-document";
import { ReactionBatcher, ReactionConfirmationGate, formatReactionBatch, reactionBatchFingerprint } from "../src/shell/core/reactions";
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


  it("preserves unfinished scaffold state in semantic context", () => {
    document.body.innerHTML = '<main id="itsalive-root"><section data-itsalive-building inert aria-busy="true"><button disabled>Start</button></section></main>';
    const result = serializeSemanticDocument();
    expect(result).toContain('data-itsalive-building=""');
    expect(result).toContain('inert=""');
    expect(result).toContain('aria-busy="true"');
    expect(result).toContain('disabled=""');
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
    const buttons = Array.from({ length: 3 }, () => document.body.appendChild(document.createElement("button")));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, historyRewriteInterval: 3 });

    for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("itsalive-history-summary")?.textContent).toContain("adjusts tempo"));

    expect(document.querySelectorAll("itsalive-interaction")).toHaveLength(0);
    const llmRequest = request.mock.calls.map(call => call[0]).find(payload => payload.type === "llm.request") as Extract<AppToShellPayload, { type: "llm.request" }>;
    expect(llmRequest.prompt).toContain("Rewrite the behavioral history");
    expect(llmRequest.prompt).toContain("New ephemeral interactions");
    observer.destroy();
  });
  it("does not evaluate pointerdown and click as separate actions", async () => {
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.1); });
    const button = document.body.appendChild(document.createElement("button"));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, historyRewriteInterval: 40 });

    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.click();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    const payload = request.mock.calls[0]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(payload.state.interaction.type).toBe("click");
    observer.destroy();
  });

  it("aggregates rapid unchanged retries and emits a frustration pattern", async () => {
    vi.useFakeTimers();
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.2); });
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Check answer";
    const observer = installInteractionObserver({ request } as never, {
      acceptUntrustedForTest: true,
      historyRewriteInterval: 40,
      repeatIdleMs: 100,
      repeatWindowMs: 1_000,
    });

    button.click();
    await Promise.resolve();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(80);
      button.click();
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(request).toHaveBeenCalledTimes(2);
    const aggregate = request.mock.calls[1]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(aggregate.state.pattern).toMatchObject({
      kind: "repeated-action",
      actionCount: 5,
      coalescedCount: 3,
      documentChangeCount: 0,
      likelyBenign: false,
      frustrationSignal: true,
    });
    observer.destroy();
  });

  it("suppresses frustration boosting for intentional rapid media-style controls", async () => {
    vi.useFakeTimers();
    const request = vi.fn((payload: AppToShellPayload) => { void payload; return response(.2); });
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Hear chord";
    const observer = installInteractionObserver({ request } as never, {
      acceptUntrustedForTest: true,
      historyRewriteInterval: 40,
      repeatIdleMs: 100,
      repeatWindowMs: 1_000,
    });

    button.click();
    await Promise.resolve();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(80);
      button.click();
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);

    const aggregate = request.mock.calls[1]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(aggregate.state.pattern).toMatchObject({
      actionCount: 5,
      likelyBenign: true,
      frustrationSignal: false,
    });
    observer.destroy();
  });

  it("does not trigger a behavioral-history rewrite for one coalesced five-click burst", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (payload: AppToShellPayload) => payload.type === "llm.request"
      ? { type: "llm.response", result: "rewritten" }
      : { type: "jev.response", probability: .2, escalated: false });
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Check";
    const observer = installInteractionObserver({ request } as never, {
      acceptUntrustedForTest: true,
      historyRewriteInterval: 3,
      repeatIdleMs: 100,
      repeatWindowMs: 1_000,
    });

    button.click();
    await Promise.resolve();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(80);
      button.click();
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);

    expect(request.mock.calls.filter(([payload]) => payload.type === "jev.request")).toHaveLength(2);
    expect(request.mock.calls.filter(([payload]) => payload.type === "llm.request")).toHaveLength(0);
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

  it("includes local interaction patterns only in user-confirmed reaction context", async () => {
    const patterned: JevState = {
      ...state(5),
      pattern: { kind: "repeated-action", actionCount: 5, coalescedCount: 3, durationMs: 320, averageIntervalMs: 80, documentChangeCount: 0, likelyBenign: false, frustrationSignal: true },
    };
    const text = formatReactionBatch({ events: [patterned], createdAt: Date.now() }, "Make the control copy its value");
    expect(text).toContain("USER CONFIRMED INTERACTION INTENT");
    expect(text).toContain("Make the control copy its value");
    expect(text).toContain('"frustrationSignal": true');
    expect(text).toContain('"actionCount": 5');
  });

  it("deduplicates the same behavioral episode while confirmation is pending", () => {
    const now = 1_000;
    let id = 0;
    const gate = new ReactionConfirmationGate(5_000, () => now, () => `prompt-${++id}`);
    const batch = { events: [state(7)], createdAt: now };

    const first = gate.offer(batch);
    const duplicate = gate.offer({ events: [state(7)], createdAt: now + 10 });

    expect(first.kind).toBe("prompt");
    expect(duplicate.kind).toBe("duplicate");
    expect(gate.current()?.id).toBe("prompt-1");
  });

  it("requires explicit confirmation before yielding a mutation-capable reaction batch", () => {
    const gate = new ReactionConfirmationGate(5_000, () => 1_000, () => "prompt-1");
    const batch = { events: [state(8)], createdAt: 1_000 };
    const offer = gate.offer(batch);
    expect(offer.kind).toBe("prompt");

    expect(gate.resolve("prompt-1").kind).toBe("dismissed");
    expect(gate.current()).toBeUndefined();

    const secondGate = new ReactionConfirmationGate(5_000, () => 1_000, () => "prompt-2");
    secondGate.offer(batch);
    const confirmed = secondGate.resolve("prompt-2", "Copy the displayed value");
    expect(confirmed.kind).toBe("confirmed");
    if (confirmed.kind === "confirmed") {
      expect(confirmed.confirmation.batch).toBe(batch);
      expect(confirmed.intent).toBe("Copy the displayed value");
    }
  });

  it("cooldowns a handled episode but allows a materially changed document to prompt", () => {
    const gate = new ReactionConfirmationGate(5_000, () => 1_000, () => "prompt-1");
    const original = { events: [state(9)], createdAt: 1_000 };
    const first = gate.offer(original);
    expect(first.kind).toBe("prompt");
    if (first.kind !== "prompt") throw new Error("expected prompt");
    gate.resolve(first.confirmation.id);

    expect(gate.offer(original).kind).toBe("cooldown");

    const changedState = { ...state(9), document: "<html><body><section>changed</section></body></html>" };
    const changed = { events: [changedState], createdAt: 1_001 };
    expect(reactionBatchFingerprint(changed)).not.toBe(reactionBatchFingerprint(original));
    expect(gate.offer(changed).kind).toBe("prompt");
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
    expect(formatReactionBatch(batch, "Keep the newest interaction")).toContain("newest");
    expect(formatReactionBatch(batch, "Keep the newest interaction").endsWith("newest")).toBe(true);
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
    const buttons = Array.from({ length: 4 }, () => document.body.appendChild(document.createElement("button")));
    const observer = installInteractionObserver({ request } as never, { acceptUntrustedForTest: true, maxInFlight: 1, historyRewriteInterval: 40 });
    for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const latest = request.mock.calls[1]![0] as Extract<AppToShellPayload, { type: "jev.request" }>;
    expect(latest.state.interaction.seq).toBe(4);
    resolvers.shift()!({ type: "jev.response", probability: .1, escalated: false });
    observer.destroy();
  });
});
