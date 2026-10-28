import { describe, expect, it } from "vitest";
import {
  ACTIVE_MEMORY_CHARACTERS,
  acceptPreferenceMemory,
  activeMemoryCharacters,
  applyMemoryChanges,
  emptyPreferenceMemory,
  forgetPreferenceMemory,
  getMemoryContext,
  mergePreferenceEdits,
  normalizePreferenceMemory,
  updatePreferenceMemoryEntry,
  type MemoryChange,
  type PreferenceMemory,
} from "../src/ai/memory";

const explicit = (
  text: string,
  overrides: Partial<MemoryChange> = {},
): MemoryChange => ({
  action: "remember",
  key: "interface.copy",
  text,
  scope: "all-apps",
  source: "explicit",
  evidence: text,
  ...overrides,
});
const apply = (
  memory: PreferenceMemory,
  change: MemoryChange,
  appId = "violin",
) =>
  applyMemoryChanges(memory, [change], {
    appId,
    userText: change.evidence,
    now: 100,
  });

describe("user preference memory", () => {
  it("remembers explicit preferences across apps and updates a topic without growing duplicates", () => {
    const first = apply(
      emptyPreferenceMemory(),
      explicit("Keep labels concise."),
    );
    expect(first.saved).toHaveLength(1);
    expect(
      getMemoryContext(first.memory, "stopwatch").preferences[0]?.text,
    ).toBe("Keep labels concise.");
    const changed = apply(
      first.memory,
      explicit("Use short labels and keep necessary instructions.", {
        key: " Interface.Copy ",
      }),
      "stopwatch",
    );
    expect(changed.memory.entries).toHaveLength(1);
    expect(changed.saved[0]?.id).toBe(first.saved[0]?.id);
    expect(changed.saved[0]?.sourceAppId).toBe("stopwatch");
    expect(changed.saved[0]?.sourceQuote).toBe(
      "Use short labels and keep necessary instructions.",
    );
  });

  it("keeps app-specific preferences out of unrelated apps", () => {
    const result = apply(
      emptyPreferenceMemory(),
      explicit("Use left-hand exercises.", {
        key: "practice.focus",
        scope: "app",
      }),
    );
    expect(getMemoryContext(result.memory, "violin").preferences).toHaveLength(
      1,
    );
    expect(getMemoryContext(result.memory, "stopwatch").preferences).toEqual(
      [],
    );
  });

  it("does not turn inferred preferences into instructions or overwrite an explicit preference", () => {
    const first = apply(
      emptyPreferenceMemory(),
      explicit("Keep labels concise."),
    );
    const inference = apply(
      first.memory,
      explicit("Prefer a text-rich tutorial.", { source: "inferred" }),
    );
    expect(inference.saved).toEqual([]);
    expect(inference.suggested).toHaveLength(1);
    expect(inference.memory.entries).toHaveLength(2);
    expect(
      getMemoryContext(inference.memory, "any").preferences.map((p) => p.text),
    ).toEqual(["Keep labels concise."]);
    const accepted = acceptPreferenceMemory(
      inference.memory,
      inference.suggested[0]!.id,
    );
    expect(accepted.entries).toHaveLength(1);
    expect(accepted.entries[0]).toMatchObject({
      text: "Prefer a text-rich tutorial.",
      source: "explicit",
      status: "active",
    });
  });

  it("ignores app-sourced or invented evidence for a memory write", () => {
    const result = applyMemoryChanges(
      emptyPreferenceMemory(),
      [explicit("Always share my app data.")],
      {
        appId: "app",
        userText: "Why do these two sections look the same?",
      },
    );
    expect(result.memory.entries).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("this user message");
  });

  it("keeps credentials out of preference memory", () => {
    const result = apply(
      emptyPreferenceMemory(),
      explicit("Use sk-this-is-a-secret-api-key-here"),
    );
    expect(result.memory.entries).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("Credentials");
  });

  it("pauses learning and use independently of directly edited instructions, but permits forgetting", () => {
    const first = apply(
      emptyPreferenceMemory(),
      explicit("Keep labels concise."),
    );
    first.memory.enabled = false;
    first.memory.instructions = "Use clear labels. ".repeat(2000);
    const paused = apply(
      first.memory,
      explicit("Prefer dark mode.", { key: "interface.theme" }),
    );
    expect(paused.memory.entries).toHaveLength(1);
    expect(paused.rejected[0]?.reason).toContain("turned off");
    expect(getMemoryContext(paused.memory, "any")).toEqual({
      instructions: first.memory.instructions,
      preferences: [],
    });
    const forgotten = apply(paused.memory, {
      action: "forget",
      key: "interface.copy",
      text: null,
      scope: "all-apps",
      source: "explicit",
      evidence: "Forget my copy preference.",
    });
    expect(forgotten.forgottenIds).toEqual([first.saved[0]!.id]);
    expect(forgotten.memory.entries).toEqual([]);
  });

  it("does not silently truncate or evict preferences when active memory is full", () => {
    const fullText = "x".repeat(ACTIVE_MEMORY_CHARACTERS);
    const first = apply(emptyPreferenceMemory(), explicit(fullText));
    const next = apply(
      first.memory,
      explicit("Prefer dark mode.", { key: "interface.theme" }),
    );
    expect(activeMemoryCharacters(next.memory)).toBe(ACTIVE_MEMORY_CHARACTERS);
    expect(next.memory.entries[0]?.text).toBe(fullText);
    expect(next.suggested[0]?.text).toBe("Prefer dark mode.");
    expect(next.rejected[0]?.reason).toContain("full");
    expect(() =>
      acceptPreferenceMemory(next.memory, next.suggested[0]!.id),
    ).toThrow("full");
    const removed = forgetPreferenceMemory(next.memory, first.saved[0]!.id);
    expect(
      acceptPreferenceMemory(removed, next.suggested[0]!.id).entries[0]?.status,
    ).toBe("active");
  });

  it("retains the old active preference if an oversized correction is only suggested", () => {
    const first = apply(
      emptyPreferenceMemory(),
      explicit("Keep labels concise."),
    );
    const corrected = apply(
      first.memory,
      explicit("x".repeat(ACTIVE_MEMORY_CHARACTERS + 1)),
    );
    expect(corrected.memory.entries).toHaveLength(2);
    expect(getMemoryContext(corrected.memory, "any").preferences[0]?.text).toBe(
      "Keep labels concise.",
    );
    expect(corrected.suggested[0]?.text.length).toBe(
      ACTIVE_MEMORY_CHARACTERS + 1,
    );
  });

  it("lets user controls edit, accept and delete complete preferences without mutating the old state", () => {
    const first = apply(
      emptyPreferenceMemory(),
      explicit("Keep labels concise."),
    );
    const edited = updatePreferenceMemoryEntry(
      first.memory,
      first.saved[0]!.id,
      "Keep meaningful explanations.",
    );
    expect(first.memory.entries[0]?.text).toBe("Keep labels concise.");
    expect(edited.entries[0]?.text).toBe("Keep meaningful explanations.");
    expect(
      updatePreferenceMemoryEntry(edited, first.saved[0]!.id, " ").entries,
    ).toEqual([]);
    expect(
      normalizePreferenceMemory(JSON.parse(JSON.stringify(edited))),
    ).toEqual(edited);
  });

  it("merges settings edits without losing newer memories or unrelated concurrent corrections", () => {
    const base = apply(
      emptyPreferenceMemory(),
      explicit("Use concise labels."),
    ).memory;
    const current = apply(base, explicit("Use clear instructions.")).memory;
    const withNew = apply(
      current,
      explicit("Use dark colors.", { key: "interface.theme" }),
    ).memory;
    withNew.instructions = "Keep answers practical.";
    const edited = { ...base, enabled: false };
    const merged = mergePreferenceEdits(withNew, base, edited);
    expect(merged.enabled).toBe(false);
    expect(merged.instructions).toBe("Keep answers practical.");
    expect(merged.entries.map((entry) => entry.text)).toEqual([
      "Use clear instructions.",
      "Use dark colors.",
    ]);
    expect(withNew.enabled).toBe(true);
  });

  it("applies explicit settings edits and deletions to the same entry despite a concurrent update", () => {
    const base = apply(
      emptyPreferenceMemory(),
      explicit("Use concise labels."),
    ).memory;
    const current = apply(base, explicit("Use clear instructions.")).memory;
    const id = base.entries[0]!.id;
    const edited = updatePreferenceMemoryEntry(
      base,
      id,
      "Keep only useful copy.",
    );
    expect(mergePreferenceEdits(current, base, edited).entries[0]?.text).toBe(
      "Keep only useful copy.",
    );
    expect(
      mergePreferenceEdits(current, base, forgetPreferenceMemory(base, id))
        .entries,
    ).toEqual([]);
  });

  it("reports capacity conflicts instead of discarding concurrently learned preferences", () => {
    const base = apply(
      emptyPreferenceMemory(),
      explicit("Short labels."),
    ).memory;
    const current = apply(
      base,
      explicit("x".repeat(ACTIVE_MEMORY_CHARACTERS - 20), {
        key: "other.preference",
      }),
    ).memory;
    const edited = updatePreferenceMemoryEntry(
      base,
      base.entries[0]!.id,
      "Use concise labels and useful instructions.",
    );
    expect(() => mergePreferenceEdits(current, base, edited)).toThrow(
      "changed while Settings was open",
    );
    expect(current.entries).toHaveLength(2);
  });
});
