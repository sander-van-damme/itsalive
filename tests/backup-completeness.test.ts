import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { Repository, validateShellSnapshot } from "../src/storage/repository";
import {
  exportBackup,
  inspectBackup,
  restoreBackup,
  summarizeBackup,
} from "../src/storage/backup";
import { digest } from "../src/compiler/cache";
import type { CodingCheckpoint } from "../src/ai/checkpoint";
import type { UsageRecord } from "../src/ai/types";
import type { OriginSnapshot } from "../src/runtime/origin-storage";

const appId = "39bca62c-8c5d-4f4f-9b7f-181555ef7b1c";
async function repository() {
  const repo = new Repository(`complete-backup-${crypto.randomUUID()}`);
  await repo.createApp(
    {
      id: appId,
      name: "Practice",
      currentRevision: "first",
      createdAt: 1,
      state: { token: "user-created app field" },
    },
    {
      id: "first",
      appId,
      parent: null,
      createdAt: 1,
      message: "Created",
      project: {
        entry: "App.tsx",
        files: { "App.tsx": "export default () => null" },
        dependencies: {},
        lock: {},
      },
    },
  );
  return repo;
}
const origin: OriginSnapshot = {
  version: 2,
  origin: `https://${appId}.itsalive.org`,
  capturedAt: 1,
  localStorage: [],
  databases: [],
  caches: [],
  opfs: [],
  reports: [],
};
const openOrigin = async () => ({
  request: async <T>(method: string) =>
    (method === "backup" ? origin : []) as T,
  close() {},
});
function usage(): UsageRecord[] {
  return Array.from({ length: 161 }, (_, i) => ({
    id: `request-${i}`,
    timestamp: i,
    role: "coding-standard",
    provider: "openai",
    model: "model",
    appId,
    correlationId: `operation-${i}`,
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 0,
    costUSD: 0.01,
    estimated: true,
    costStatus: "estimated",
    usageStatus: "reported",
    latencyMs: 1000,
    status: "success",
  }));
}
async function checkpoint(repo: Repository): Promise<CodingCheckpoint> {
  return {
    version: 1,
    id: "draft-one",
    appId,
    baseRevisionId: "first",
    originalRequest: "Help me practice",
    intent: "Create left-hand practice",
    role: "coding-standard",
    correlationId: "build-one",
    createdAt: 2,
    updatedAt: 3,
    project: (await repo.getRevision("first"))!.project,
    changedFiles: ["App.tsx"],
    messages: Array.from({ length: 150 }, (_, i) => ({
      role: "user",
      content: `Continue ${i}`,
    })),
    turns: 30,
    toolCalls: 150,
    finishRequested: true,
    summary: "Practice is ready",
    status: "paused",
    receipts: Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `call-${i}`,
        {
          name: "write_file",
          arguments: `arguments-${i}`,
          output: `output-${i}`,
          ok: true,
        },
      ]),
    ),
  };
}

describe("lossless backup coverage", () => {
  it("round-trips more than 100 charges, nested settings and long instructions without modifying application data", async () => {
    const repo = await repository();
    const records = usage();
    const instruction = "Make all words useful. ".repeat(2000);
    const properties = Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [`preference-${i}`, i]),
    );
    await repo.setSetting("ai.usage", records);
    await repo.setSetting("preferences", {
      instruction,
      choices: Array.from({ length: 200 }, (_, i) => i),
      properties,
      accessToken: "must-not-travel",
    });
    const archive = await exportBackup(repo, openOrigin);
    const manifest = await inspectBackup(archive);
    expect(manifest.coverage).toMatchObject({
      usageRecords: 161,
      unknownUsageRecords: 0,
      codingDrafts: 0,
    });
    expect(manifest.coverage!.knownUsageCostUSD).toBeCloseTo(1.61);
    expect(await archive.text()).not.toContain("must-not-travel");
    const target = new Repository(`restored-${crypto.randomUUID()}`);
    await restoreBackup(archive, target, openOrigin);
    expect(await target.getSetting("ai.usage")).toEqual(records);
    expect(await target.getSetting("preferences")).toEqual({
      instruction,
      choices: Array.from({ length: 200 }, (_, i) => i),
      properties,
      accessToken: "[redacted]",
    });
    expect((await target.getApp(appId))!.state.token).toBe(
      "user-created app field",
    );
    expect(summarizeBackup(manifest)).toMatchObject({
      complete: true,
      summary: "Backup saved. Your apps and their history are included.",
    });
    await repo.close();
    await target.close();
  });

  it("restores resumable model context, receipts, pending calls and dependencies belonging only to a candidate", async () => {
    const repo = await repository();
    const draft = await checkpoint(repo);
    const bytes = new TextEncoder().encode(
      'export const instrument = "violin";',
    );
    const url = "https://esm.sh/candidate-only@1.0.0/es2022/module.mjs";
    draft.project.lock = { [url]: { url, integrity: await digest(bytes) } };
    draft.pending = {
      calls: [
        { id: "pending", name: "finish", arguments: '{"summary":"Ready"}' },
      ],
      next: 0,
      incomplete: false,
    };
    draft.archivedContexts = [
      [{ role: "assistant", content: "Already changed left-hand exercises" }],
    ];
    await repo.saveCodingCheckpoint(draft);
    const cached = new Map([[url, new Response(bytes)]]);
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (key: string) => cached.get(key)?.clone(),
        put: async (key: string, response: Response) => {
          cached.set(key, response);
        },
      }),
    });
    const target = new Repository(`candidate-restored-${crypto.randomUUID()}`);
    try {
      const archive = await exportBackup(repo, openOrigin);
      const manifest = await inspectBackup(archive);
      expect(manifest.coverage!.codingDrafts).toBe(1);
      expect(manifest.dependencies).toHaveLength(1);
      cached.clear();
      await restoreBackup(archive, target, openOrigin);
      expect(await target.getCodingCheckpoint(appId)).toEqual(draft);
      expect(await cached.get(url)!.text()).toBe(
        new TextDecoder().decode(bytes),
      );
      expect((await target.getApp(appId))!.currentRevision).toBe("first");
    } finally {
      vi.unstubAllGlobals();
      await repo.close();
      await target.close();
    }
  });

  it("rejects malformed or stale recovery candidates before restoring any app", async () => {
    const repo = await repository();
    await repo.saveCodingCheckpoint(await checkpoint(repo));
    const snapshot = await repo.exportData();
    snapshot.codingDrafts![0]!.baseRevisionId = "missing-revision";
    expect(() => validateShellSnapshot(snapshot)).toThrow("stale");
    snapshot.codingDrafts![0]!.baseRevisionId = "first";
    snapshot.codingDrafts![0]!.pending = {
      calls: [],
      next: 1,
      incomplete: false,
    };
    expect(() => validateShellSnapshot(snapshot)).toThrow("continuation");
    await repo.close();
  });

  it("excludes browser OAuth settings defensively and declares missing legacy coverage", async () => {
    const repo = await repository();
    await expect(
      repo.setSetting("itsalive.chatgpt.account", { accessToken: "secret" }),
    ).rejects.toThrow("credentials separately");
    await expect(
      repo.setSetting("chatgpt.refreshToken", "secret"),
    ).rejects.toThrow("credentials separately");
    await expect(
      repo.setSetting("oauth.codeVerifier", "secret"),
    ).rejects.toThrow("credentials separately");
    await expect(repo.setSetting("clientSecret", "secret")).rejects.toThrow(
      "credentials separately",
    );
    const manifest = await inspectBackup(await exportBackup(repo, openOrigin));
    delete manifest.coverage;
    expect(summarizeBackup(manifest).complete).toBe(false);
    expect(summarizeBackup(manifest).details.join(" ")).toContain(
      "does not declare",
    );
    await repo.close();
  });

  it("rejects duplicate settings and invalid or duplicate usage before replacing destination state", async () => {
    const repo = await repository();
    await repo.setSetting("ai.usage", usage());
    const snapshot = await repo.exportData();
    const saved = structuredClone(snapshot);
    snapshot.settings.push(snapshot.settings[0]!);
    await expect(repo.importData(snapshot)).rejects.toThrow("setting");
    const ledger = saved.settings.find((setting) => setting.key === "ai.usage")!
      .value as UsageRecord[];
    ledger[0]!.costUSD = -1;
    await expect(repo.importData(saved)).rejects.toThrow("usage");
    ledger[0]!.costUSD = 0.01;
    ledger[1]!.id = ledger[0]!.id;
    await expect(repo.importData(saved)).rejects.toThrow("duplicate usage");
    expect(await repo.getSetting("ai.usage")).toEqual(usage());
    await repo.close();
  });
});
