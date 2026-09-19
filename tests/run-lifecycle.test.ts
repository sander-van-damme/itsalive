import { describe, expect, it } from "vitest";
import {
  PausedRunStore,
  createAgentAbort,
  normalizeAgentRunFailure,
} from "../src/shell/core/run-lifecycle";

describe("agent run lifecycle semantics", () => {
  it("maps a raw stream abort to user-stop product language when the signal says the user stopped", () => {
    const controller = new AbortController();
    controller.abort(createAgentAbort("user-stop"));

    const result = normalizeAgentRunFailure(new Error("BodyStreamBuffer was aborted"), controller.signal);

    expect(result).toMatchObject({
      kind: "user-stop",
      resumable: false,
      userMessage: "Stopped. Changes already applied were kept.",
      technical: { message: "BodyStreamBuffer was aborted" },
    });
    expect(result.userMessage).not.toContain("BodyStreamBuffer");
  });

  it("marks app-switch cancellation as resumable without exposing a technical chat message", () => {
    const controller = new AbortController();
    controller.abort(createAgentAbort("app-switch"));

    expect(normalizeAgentRunFailure(new Error("fetch aborted"), controller.signal)).toMatchObject({
      kind: "app-switch",
      resumable: true,
      userMessage: undefined,
    });
  });

  it("stores, consumes, and restores one paused request per app", () => {
    let id = 0;
    const store = new PausedRunStore(() => `paused-${++id}`, () => 1234);
    const paused = store.pause("app-a", "Make the background pink");

    expect(store.current("app-a")).toEqual(paused);
    expect(store.take("app-a", "stale")).toBeUndefined();
    expect(store.take("app-a", paused.id)).toEqual(paused);
    expect(store.current("app-a")).toBeUndefined();

    store.restore(paused);
    expect(store.current("app-a")?.trigger).toBe("Make the background pink");
    store.clear("app-a");
    expect(store.current("app-a")).toBeUndefined();
  });
});
