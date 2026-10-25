import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  AIError,
  AIService,
  ScriptedProvider,
  defaultAIConfig,
  parseResponse,
  type AIResponse,
  type UsageRecord,
} from "../src/ai";
import { Repository } from "../src/storage/repository";
const context = { appId: "app", correlationId: "durable-usage" };
const input = {
  messages: [{ role: "user" as const, content: "Create practice" }],
};
const answer: AIResponse = {
  text: "Done",
  toolCalls: [],
  usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0, costUSD: 0.02 },
};
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const credentials = () => ({ openai: "key" });
const repository = () =>
  new Repository(`durable-accounting-${crypto.randomUUID()}`);

describe("durable request accounting", () => {
  it("awaits durable pending before transport and durable reported usage before resolving, then restores the charge on reload", async () => {
    const repo = repository();
    const pendingWrite = deferred();
    const finalWrite = deferred();
    const provider = new ScriptedProvider([answer]);
    const persisted: UsageRecord[] = [];
    const service = new AIService(defaultAIConfig(), {
      providers: { openai: provider },
      credentials,
      onUsage: async (record) => {
        await (record.status === "pending"
          ? pendingWrite.promise
          : finalWrite.promise);
        await repo.recordUsage(record);
        persisted.push(record);
      },
    });
    let settled = false;
    const request = service
      .generate("coding-standard", input, context)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(service.usage).toHaveLength(1));
    expect(provider.requests).toHaveLength(0);
    pendingWrite.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(persisted[0]!.status).toBe("pending");
    expect(settled).toBe(false);
    expect(service.activeRequestCount).toBe(1);
    finalWrite.resolve();
    await request;
    const reloaded = new AIService(defaultAIConfig());
    reloaded.importUsage((await repo.getSetting<UsageRecord[]>("ai.usage"))!);
    expect(reloaded.spentUSD).toBe(0.02);
    expect(reloaded.usage[0]).toMatchObject({
      status: "success",
      usageStatus: "reported",
      costStatus: "reported",
    });
  });

  it("retains failed response usage durably before rejecting the original provider failure", async () => {
    const repo = repository();
    const finishWrite = deferred();
    let failure!: AIError;
    try {
      parseResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 20, output_tokens: 10 },
        output: [],
      });
    } catch (error) {
      failure = error as AIError;
    }
    const service = new AIService(defaultAIConfig(), {
      providers: { openai: new ScriptedProvider([failure]) },
      credentials,
      onUsage: async (record) => {
        if (record.status !== "pending") await finishWrite.promise;
        await repo.recordUsage(record);
      },
    });
    let rejected = false;
    const result = service
      .generate("coding-standard", input, context)
      .catch((error) => {
        rejected = true;
        return error;
      });
    await vi.waitFor(() => expect(service.usage[0]?.status).toBe("failed"));
    expect(rejected).toBe(false);
    finishWrite.resolve();
    expect(await result).toBe(failure);
    const records = (await repo.getSetting<UsageRecord[]>("ai.usage"))!;
    expect(records[0]).toMatchObject({
      status: "failed",
      inputTokens: 20,
      outputTokens: 10,
      usageStatus: "reported",
    });
    expect(records[0]!.costUSD).toBeGreaterThan(0);
  });

  it("removes the exact unstarted record when one concurrent pending write fails", async () => {
    const firstWrite = deferred();
    const secondResponse = deferred<AIResponse>();
    const provider = new ScriptedProvider([() => secondResponse.promise]);
    let firstId = "";
    const service = new AIService(defaultAIConfig(), {
      providers: { openai: provider },
      credentials,
      onUsage: (record) => {
        if (!firstId) firstId = record.id;
        if (record.id === firstId) return firstWrite.promise;
      },
    });
    const first = service
      .generate("coding-standard", input, context)
      .catch((error) => error);
    await vi.waitFor(() => expect(firstId).not.toBe(""));
    const second = service.generate("conversation", input, context);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const secondId = service.usage.find((record) => record.id !== firstId)!.id;
    firstWrite.reject(new Error("storage full"));
    expect(await first).toBeInstanceOf(Error);
    expect(service.usage.map((record) => record.id)).toEqual([secondId]);
    secondResponse.resolve(answer);
    await second;
    expect(service.spentUSD).toBe(0.02);
    expect(provider.requests).toHaveLength(1);
  });

  it("rechecks the spending threshold after waiting for pending persistence", async () => {
    const delayedPending = deferred();
    const providerResult = deferred<AIResponse>();
    const provider = new ScriptedProvider([() => providerResult.promise]);
    const config = defaultAIConfig();
    config.limits.budgetEnabled = true;
    config.limits.budgetUSD = 0.01;
    let firstId = "";
    const service = new AIService(config, {
      providers: { openai: provider },
      credentials,
      onUsage: (record) => {
        if (!firstId) firstId = record.id;
        if (record.id !== firstId && record.status === "pending")
          return delayedPending.promise;
      },
    });
    const first = service.generate("coding-standard", input, context);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const second = service
      .generate("conversation", input, context)
      .catch((error) => error);
    await vi.waitFor(() => expect(service.usage).toHaveLength(2));
    providerResult.resolve(answer);
    await first;
    delayedPending.resolve();
    expect(await second).toMatchObject({ kind: "limit" });
    expect(provider.requests).toHaveLength(1);
    expect(service.usage[1]).toMatchObject({
      status: "failed",
      costStatus: "not-billed",
    });
  });

  it("pauses on failed final persistence and repairs that charge before allowing another request", async () => {
    const repo = repository();
    let storageBroken = true;
    const provider = new ScriptedProvider([answer, answer]);
    const service = new AIService(defaultAIConfig(), {
      providers: { openai: provider },
      credentials,
      onUsage: async (record) => {
        if (record.status !== "pending" && storageBroken)
          throw new Error("storage full");
        await repo.recordUsage(record);
      },
    });
    await expect(
      service.generate("coding-standard", input, context),
    ).rejects.toMatchObject({
      kind: "accounting",
      response: { completion: { recoverable: false } },
    });
    expect(service.spentUSD).toBe(0.02);
    expect((await repo.getSetting<UsageRecord[]>("ai.usage"))![0]!.status).toBe(
      "pending",
    );
    await expect(
      service.generate("coding-standard", input, context),
    ).rejects.toMatchObject({ kind: "accounting" });
    expect(provider.requests).toHaveLength(1);
    storageBroken = false;
    await service.generate("coding-standard", input, context);
    const reloaded = new AIService(defaultAIConfig());
    reloaded.importUsage((await repo.getSetting<UsageRecord[]>("ai.usage"))!);
    expect(reloaded.spentUSD).toBe(0.04);
    expect(reloaded.usage.every((record) => record.status === "success")).toBe(
      true,
    );
  });

  it("keeps the provider failure classification when persisting its failed usage also fails", async () => {
    const response = {
      text: "",
      toolCalls: [],
      usage: answer.usage,
      completion: {
        status: "incomplete" as const,
        reason: "max_output_tokens",
        recoverable: true,
      },
    };
    const service = new AIService(defaultAIConfig(), {
      providers: {
        openai: new ScriptedProvider([
          new AIError(
            "Interrupted",
            "response",
            { reason: "max_output_tokens" },
            response,
          ),
        ]),
      },
      credentials,
      onUsage: async (record) => {
        if (record.status !== "pending")
          throw new Error("private storage detail");
      },
    });
    const error = await service
      .generate("coding-standard", input, context)
      .catch((failure) => failure);
    expect(error).toMatchObject({
      kind: "accounting",
      detail: {
        providerFailureKind: "response",
        providerFailureReason: "max_output_tokens",
      },
      response: { completion: { recoverable: false } },
    });
    expect(error.message).not.toContain("private storage detail");
    expect(service.spentUSD).toBe(0.02);
  });

  it("awaits the parent ledger when validating a connection and removes an unstarted failed probe", async () => {
    const firstWrite = deferred();
    const provider = new ScriptedProvider([]);
    const service = new AIService(defaultAIConfig(), {
      providers: { openai: provider },
      credentials,
      onUsage: () => firstWrite.promise,
    });
    const result = service
      .testConfiguration(defaultAIConfig(), { openai: "key" }, context)
      .catch((error) => error);
    await vi.waitFor(() => expect(service.usage).toHaveLength(1));
    expect(provider.requests).toHaveLength(0);
    firstWrite.reject(new Error("storage full"));
    expect(await result).toMatchObject({ kind: "accounting" });
    expect(service.usage).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("observes rejected asynchronous voice accounting writes without unhandled rejection", async () => {
    const log = vi.fn();
    const service = new AIService(defaultAIConfig(), {
      log,
      onUsage: async () => {
        throw new Error("storage failed");
      },
    });
    const voice = service.startVoice(context);
    voice.update(20, true, true);
    await vi.waitFor(() =>
      expect(
        log.mock.calls.filter(
          ([event]) => event.event === "ai.accounting.persist.failure",
        ),
      ).toHaveLength(2),
    );
    expect(service.usage[0]!.costStatus).toBe("estimated");
  });
});
