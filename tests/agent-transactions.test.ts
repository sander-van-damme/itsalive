// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createAgentTransactionController } from "../src/runtime/agent-transactions";
import { createApplicationStore } from "../src/runtime/application-store";
import { installAgentDurabilityAudit } from "../src/runtime/durability";
import { serializeAppDocument } from "../src/runtime/persistence";

function fixture() {
  document.documentElement.lang = "en";
  document.head.innerHTML = "<title>Transaction test</title>";
  document.body.innerHTML = '<main id="itsalive-root"><section id="feature"><input id="name" value="real"><button id="action">Act</button><p id="result">ready</p></section></main>';
  const applicationStore = createApplicationStore();
  applicationStore.store.records = [{ id: "real", title: "Real item" }];
  const autosave = {
    suspend: vi.fn(),
    resume: vi.fn(),
  };
  const durability = installAgentDurabilityAudit();
  const rollbackErrors: unknown[] = [];
  const transactions = createAgentTransactionController({
    applicationStore,
    autosave,
    durability,
    onRollbackError: error => rollbackErrors.push(error),
  });
  return { applicationStore, autosave, durability, transactions, rollbackErrors };
}

describe("agent execution transactions", () => {
  it("rolls back DOM and application.store when an agent command fails", async () => {
    const { applicationStore, autosave, durability, transactions } = fixture();
    const before = serializeAppDocument(applicationStore.snapshot());

    await expect(transactions.runCommand(async () => durability.runAgentCommand(async () => {
      document.querySelector("#result")!.textContent = "partial mutation";
      (applicationStore.store.records as Array<{ id: string; title: string }>).push({ id: "temporary", title: "Temporary" });
      throw new Error("verification exploded");
    }))).rejects.toThrow("verification exploded");

    expect(serializeAppDocument(applicationStore.snapshot())).toEqual(before);
    expect(document.body.textContent).not.toContain("partial mutation");
    expect(applicationStore.snapshot()).not.toContain("temporary");
    expect(autosave.suspend).toHaveBeenCalledOnce();
    expect(autosave.resume).toHaveBeenCalledOnce();
    durability.destroy();
  });

  it("keeps successful implementation changes while agent.verify always rolls temporary probes back", async () => {
    const { applicationStore, durability, transactions } = fixture();

    const verificationResult = await transactions.runCommand(async () => durability.runAgentCommand(async () => {
      document.querySelector("#result")!.textContent = "implemented";
      applicationStore.store.mode = "implemented";

      const observed = await transactions.verify(async () => {
        const input = document.querySelector<HTMLInputElement>("#name")!;
        input.value = "temporary input";
        (applicationStore.store.records as Array<{ id: string; title: string }>).push({ id: "probe", title: "Probe record" });
        document.querySelector("#result")!.textContent = "temporary result";
        window.addEventListener("probe-event", () => undefined);
        await Promise.resolve();
        return {
          input: input.value,
          recordCount: (applicationStore.store.records as unknown[]).length,
          result: document.querySelector("#result")!.textContent,
        };
      });

      expect(document.querySelector<HTMLInputElement>("#name")!.value).toBe("real");
      expect(document.querySelector("#result")!.textContent).toBe("implemented");
      expect(applicationStore.store.mode).toBe("implemented");
      expect(applicationStore.snapshot()).not.toContain("Probe record");
      return observed;
    }));

    expect(verificationResult).toEqual({
      input: "temporary input",
      recordCount: 2,
      result: "temporary result",
    });
    expect(durability.audit().runtimeOnlyEventListenerCount).toBe(0);
    expect(document.querySelector("#result")!.textContent).toBe("implemented");
    expect(applicationStore.store.mode).toBe("implemented");
    durability.destroy();
  });

  it("restores verification state before rethrowing an async verification error", async () => {
    const { applicationStore, durability, transactions } = fixture();
    const before = serializeAppDocument(applicationStore.snapshot());

    await expect(transactions.runCommand(async () => durability.runAgentCommand(async () => {
      await transactions.verify(async () => {
        document.querySelector("#result")!.textContent = "probe failed";
        applicationStore.store.probe = { active: true };
        await Promise.resolve();
        throw new Error("probe failure");
      });
    }))).rejects.toThrow("probe failure");

    expect(serializeAppDocument(applicationStore.snapshot())).toEqual(before);
    expect(applicationStore.snapshot()).not.toContain("probe");
    durability.destroy();
  });

  it("rejects verification transactions outside an active agent command", async () => {
    const { durability, transactions } = fixture();
    await expect(transactions.verify(() => true)).rejects.toThrow("only while an agent command is executing");
    durability.destroy();
  });
});
