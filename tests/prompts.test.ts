import { describe, expect, it } from "vitest";
import {
  CODING_MANAGER_PLAN_PROMPT,
  CODING_MANAGER_VERIFY_PROMPT,
  CODING_WORKER_SYSTEM_PROMPT,
  USER_INTENT_SYSTEM_PROMPT,
} from "../src/shell/core/prompts";

describe("role-owned agent prompts", () => {
  it("gives component workers one explicit atomic console mental model", () => {
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("live browser component through a JavaScript console");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("exactly one complete executable JavaScript program per turn");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("executes it once");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("value, console output, runtime error");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("/* itsalive:command */");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("/* itsalive:end */");
  });

  it("keeps worker instructions focused on non-obvious platform invariants", () => {
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("component is the Element you own");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("Browser DOM and Web APIs are available");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("Durable data belongs in application.store");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("transient command listeners");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("shell owns build/progress attributes");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("Do not verify by inserting");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("return agent.done(JSON.stringify(handoff))");
    expect(CODING_WORKER_SYSTEM_PROMPT).toContain("SELECTED PLATFORM API HELP");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("getElementById");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("querySelector");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("Custom Elements");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("framework");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("Jev");
    expect(CODING_WORKER_SYSTEM_PROMPT).not.toContain("OpenRouter");
  });

  it("keeps manager planning separate from worker execution", () => {
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("Plan implementation and coordination");
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("Do not write DOM mutation code");
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("ESTABLISHED APP CONTRACT");
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("canonical shared contract");
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("component-worker");
    expect(CODING_MANAGER_PLAN_PROMPT).toContain("repair-worker");
    expect(CODING_MANAGER_PLAN_PROMPT).not.toContain("return agent.done");
  });

  it("keeps final verification evidence-based and user-safe", () => {
    expect(CODING_MANAGER_VERIFY_PROMPT).toContain("CURRENT SCOPE EVIDENCE");
    expect(CODING_MANAGER_VERIFY_PROMPT).toContain("Current deterministic evidence is authoritative");
    expect(CODING_MANAGER_VERIFY_PROMPT).toContain("Handoff status is historical diagnostic evidence");
    expect(CODING_MANAGER_VERIFY_PROMPT).toContain("user-facing product language");
    expect(CODING_MANAGER_VERIFY_PROMPT).not.toContain("write DOM mutation code");
  });

  it("keeps user-intent authorization separate from coding", () => {
    expect(USER_INTENT_SYSTEM_PROMPT).toContain("before coding is authorized");
    expect(USER_INTENT_SYSTEM_PROMPT).toMatch(/explanation.*not permission/i);
    expect(USER_INTENT_SYSTEM_PROMPT).toContain("telemetry is evidence");
    expect(USER_INTENT_SYSTEM_PROMPT).toContain("Available platform APIs");
    expect(USER_INTENT_SYSTEM_PROMPT).toContain("application.ai.decide");
  });
});
