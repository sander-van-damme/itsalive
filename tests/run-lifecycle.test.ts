import { describe, expect, it } from "vitest";
import {
  AGENT_TIME_BUDGET_REASON,
  PausedRunStore,
  createAgentAbort,
  createAgentTimeout,
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

    const result = normalizeAgentRunFailure(new Error("fetch aborted"), controller.signal);
    expect(result).toMatchObject({ kind: "app-switch", resumable: true });
    expect(result.userMessage).toBeUndefined();
  });

  it("does not claim changes were kept when coding-manager planning failed before mutation", () => {
    const result = normalizeAgentRunFailure(new Error("Coding manager returned invalid JSON"));
    expect(result).toMatchObject({
      kind: "run-error",
      resumable: false,
      userMessage: "I hit a problem before app changes started. Nothing was changed. Try again.",
    });
  });

  it("still reports kept changes for integration-verification failures after workers may have mutated the app", () => {
    const result = normalizeAgentRunFailure(new Error("Coding manager verification returned invalid JSON"));
    expect(result.userMessage).toBe("I hit a problem while working. Changes already applied were kept. Try again.");
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
  it("maps the working-time budget to explicit product language", () => {
    const controller = new AbortController();
    controller.abort(createAgentTimeout("time-budget"));
    const result = normalizeAgentRunFailure(new Error("stream aborted"), controller.signal);

    expect(result).toMatchObject({
      kind: "time-budget",
      resumable: false,
      userMessage: "This run reached its working-time budget, so I stopped it. Changes already applied were kept.",
    });
    expect(controller.signal.reason).toMatchObject({ name: "TimeoutError", message: AGENT_TIME_BUDGET_REASON });
  });


});
