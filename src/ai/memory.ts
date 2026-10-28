/** User-facing preferences, separate from conversation history and model capacity. */
export const PREFERENCE_MEMORY_SETTING = "user.preferences";
/** Keeps the user's remembered preference list readable; never truncates a model request. */
export const ACTIVE_MEMORY_CHARACTERS = 6_000;

export interface PreferenceMemoryEntry {
  id: string;
  key: string;
  text: string;
  scope: "all-apps" | "app";
  appId: string | null;
  source: "explicit" | "inferred";
  status: "active" | "suggested";
  createdAt: number;
  updatedAt: number;
  sourceAppId: string;
  sourceQuote: string;
}

export interface PreferenceMemory {
  version: 1;
  enabled: boolean;
  instructions: string;
  entries: PreferenceMemoryEntry[];
}

export interface MemoryChange {
  action: "remember" | "forget";
  /** Stable topic, for example interface.copy or conversation.tone. */
  key: string;
  text: string | null;
  scope: "all-apps" | "app";
  source: "explicit" | "inferred";
  /** A literal excerpt from this user turn; app content cannot authorize memory writes. */
  evidence: string;
}

export interface MemoryChangeResult {
  memory: PreferenceMemory;
  saved: PreferenceMemoryEntry[];
  suggested: PreferenceMemoryEntry[];
  forgottenIds: string[];
  rejected: Array<{ change: MemoryChange; reason: string }>;
}

export function emptyPreferenceMemory(): PreferenceMemory {
  return { version: 1, enabled: true, instructions: "", entries: [] };
}

const normalized = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function isEntry(value: unknown): value is PreferenceMemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    !!entry.id &&
    typeof entry.key === "string" &&
    !!entry.key.trim() &&
    typeof entry.text === "string" &&
    !!entry.text.trim() &&
    (entry.scope === "all-apps" || entry.scope === "app") &&
    (entry.scope === "all-apps"
      ? entry.appId === null
      : typeof entry.appId === "string" && !!entry.appId) &&
    (entry.source === "explicit" || entry.source === "inferred") &&
    (entry.status === "active" || entry.status === "suggested") &&
    typeof entry.createdAt === "number" &&
    Number.isFinite(entry.createdAt) &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    typeof entry.sourceAppId === "string" &&
    typeof entry.sourceQuote === "string"
  );
}

export function normalizePreferenceMemory(value: unknown): PreferenceMemory {
  if (!value || typeof value !== "object") return emptyPreferenceMemory();
  const stored = value as Partial<PreferenceMemory>;
  return {
    version: 1,
    enabled: stored.enabled !== false,
    instructions:
      typeof stored.instructions === "string" ? stored.instructions : "",
    entries: Array.isArray(stored.entries)
      ? stored.entries.filter(isEntry).map((entry) => ({ ...entry }))
      : [],
  };
}

export function activeMemoryCharacters(memory: PreferenceMemory): number {
  return memory.entries.reduce(
    (total, entry) =>
      total + (entry.status === "active" ? entry.text.length : 0),
    0,
  );
}

function sameScope(
  entry: PreferenceMemoryEntry,
  change: MemoryChange,
  appId: string,
) {
  return (
    entry.scope === change.scope &&
    (change.scope === "all-apps" || entry.appId === appId)
  );
}

export function applyMemoryChanges(
  value: PreferenceMemory,
  changes: readonly MemoryChange[],
  context: { appId: string; userText: string; now?: number },
): MemoryChangeResult {
  const memory = normalizePreferenceMemory(value);
  const result: MemoryChangeResult = {
    memory,
    saved: [],
    suggested: [],
    forgottenIds: [],
    rejected: [],
  };
  for (const change of changes) {
    const reject = (reason: string) => result.rejected.push({ change, reason });
    if (
      !change.evidence.trim() ||
      !context.userText.includes(change.evidence)
    ) {
      reject("The preference must be supported by this user message.");
      continue;
    }
    if (!change.key.trim()) {
      reject("A preference topic is required.");
      continue;
    }
    const matches = memory.entries.filter(
      (entry) =>
        sameScope(entry, change, context.appId) &&
        normalized(entry.key) === normalized(change.key),
    );
    if (change.action === "forget") {
      if (change.source !== "explicit") {
        reject("Forgetting a preference needs the user's request.");
        continue;
      }
      const ids = new Set(matches.map((entry) => entry.id));
      memory.entries = memory.entries.filter((entry) => !ids.has(entry.id));
      result.forgottenIds.push(...ids);
      continue;
    }
    if (!memory.enabled) {
      reject("Remembering preferences is turned off.");
      continue;
    }
    if (!change.text?.trim()) {
      reject("A remembered preference cannot be empty.");
      continue;
    }
    if (
      /\b(?:sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/i.test(
        change.text + " " + change.evidence,
      )
    ) {
      reject("Credentials belong in the AI connection, not preference memory.");
      continue;
    }
    // An inferred correction cannot replace an active explicit instruction.
    const existing =
      matches.find(
        (entry) =>
          change.source === "explicit" ||
          entry.status === "suggested" ||
          entry.source === "inferred",
      ) ??
      memory.entries.find(
        (entry) =>
          sameScope(entry, change, context.appId) &&
          normalized(entry.text) === normalized(change.text!),
      );
    if (existing?.status === "active" && change.source === "inferred") {
      if (normalized(existing.text) === normalized(change.text)) continue;
    }
    const now = context.now ?? Date.now();
    const entry: PreferenceMemoryEntry = {
      id: existing?.id ?? crypto.randomUUID(),
      key: change.key.trim(),
      text: change.text.trim(),
      scope: change.scope,
      appId: change.scope === "app" ? context.appId : null,
      source: change.source,
      status: change.source === "explicit" ? "active" : "suggested",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceAppId: context.appId,
      sourceQuote: change.evidence,
    };
    const withoutExisting = memory.entries.filter(
      (item) => item.id !== entry.id,
    );
    const activeSize = activeMemoryCharacters({
      ...memory,
      entries: withoutExisting,
    });
    if (
      entry.status === "active" &&
      activeSize + entry.text.length > ACTIVE_MEMORY_CHARACTERS
    ) {
      // Keep the complete proposal and every existing active preference. Never silently drop context.
      entry.status = "suggested";
      if (existing?.status === "active") {
        entry.id = crypto.randomUUID();
        entry.createdAt = now;
      }
      result.rejected.push({
        change,
        reason:
          "Preference memory is full. Shorten or remove an existing preference to use this suggestion.",
      });
    }
    memory.entries = memory.entries.filter((item) => item.id !== entry.id);
    // Explicit updates supersede stale suggestions on the same topic; unrelated memories remain untouched.
    if (entry.status === "active") {
      memory.entries = memory.entries.filter(
        (item) =>
          !(
            item.status === "suggested" &&
            sameScope(item, change, context.appId) &&
            normalized(item.key) === normalized(change.key)
          ),
      );
    }
    memory.entries.push(entry);
    (entry.status === "active" ? result.saved : result.suggested).push({
      ...entry,
    });
  }
  return result;
}

export function getMemoryContext(memory: PreferenceMemory, appId: string) {
  return {
    instructions: memory.instructions,
    preferences: memory.enabled
      ? memory.entries
          .filter(
            (entry) =>
              entry.status === "active" &&
              (entry.scope === "all-apps" || entry.appId === appId),
          )
          .map(({ id, key, text, scope, source }) => ({
            id,
            key,
            text,
            scope,
            source,
          }))
      : [],
  };
}

export function forgetPreferenceMemory(
  memory: PreferenceMemory,
  id: string,
): PreferenceMemory {
  return {
    ...normalizePreferenceMemory(memory),
    entries: memory.entries.filter((entry) => entry.id !== id),
  };
}

/** Called only from the user's preference controls, not from untrusted model output. */
export function updatePreferenceMemoryEntry(
  memory: PreferenceMemory,
  id: string,
  text: string,
): PreferenceMemory {
  if (!text.trim()) return forgetPreferenceMemory(memory, id);
  const next = normalizePreferenceMemory(memory);
  const current = next.entries.find((entry) => entry.id === id);
  if (!current) return next;
  const sizeWithout =
    activeMemoryCharacters(next) -
    (current.status === "active" ? current.text.length : 0);
  if (
    current.status === "active" &&
    sizeWithout + text.trim().length > ACTIVE_MEMORY_CHARACTERS
  )
    throw new Error(
      "Preference memory is full. Shorten or remove another preference first.",
    );
  Object.assign(current, {
    text: text.trim(),
    source: "explicit",
    updatedAt: Date.now(),
  });
  return next;
}

export function acceptPreferenceMemory(
  memory: PreferenceMemory,
  id: string,
): PreferenceMemory {
  const next = normalizePreferenceMemory(memory);
  const entry = next.entries.find((item) => item.id === id);
  if (!entry || entry.status === "active") return next;
  const replaced = next.entries.filter(
    (item) =>
      item.id !== id &&
      item.scope === entry.scope &&
      item.appId === entry.appId &&
      normalized(item.key) === normalized(entry.key),
  );
  const removedSize = replaced.reduce(
    (sum, item) => sum + (item.status === "active" ? item.text.length : 0),
    0,
  );
  if (
    activeMemoryCharacters(next) - removedSize + entry.text.length >
    ACTIVE_MEMORY_CHARACTERS
  )
    throw new Error(
      "Preference memory is full. Shorten or remove another preference first.",
    );
  const ids = new Set(replaced.map((item) => item.id));
  next.entries = next.entries.filter((item) => !ids.has(item.id));
  Object.assign(entry, {
    status: "active",
    source: "explicit",
    updatedAt: Date.now(),
  });
  return next;
}

/** Merge the fields a user changed in Settings without erasing newer conversation memories. */
export function mergePreferenceEdits(
  current: PreferenceMemory,
  base: PreferenceMemory,
  edited: PreferenceMemory,
): PreferenceMemory {
  const next = normalizePreferenceMemory(current);
  if (base.enabled !== edited.enabled) next.enabled = edited.enabled;
  if (base.instructions !== edited.instructions)
    next.instructions = edited.instructions;
  const baseEntries = new Map(base.entries.map((entry) => [entry.id, entry]));
  const editedEntries = new Map(
    edited.entries.map((entry) => [entry.id, entry]),
  );
  const removed = new Set(
    base.entries
      .filter((entry) => !editedEntries.has(entry.id))
      .map((entry) => entry.id),
  );
  next.entries = next.entries.filter((entry) => !removed.has(entry.id));
  for (const entry of edited.entries) {
    if (JSON.stringify(baseEntries.get(entry.id)) === JSON.stringify(entry))
      continue;
    const existing = next.entries.findIndex((item) => item.id === entry.id);
    if (existing < 0) next.entries.push({ ...entry });
    else next.entries[existing] = { ...entry };
    // An explicitly edited or accepted topic wins over a concurrent alternative.
    if (entry.status === "active")
      next.entries = next.entries.filter(
        (item) =>
          item.id === entry.id ||
          item.scope !== entry.scope ||
          item.appId !== entry.appId ||
          normalized(item.key) !== normalized(entry.key),
      );
  }
  if (activeMemoryCharacters(next) > ACTIVE_MEMORY_CHARACTERS)
    throw new Error(
      "Preference memory changed while Settings was open and is now full. Shorten a preference or reopen Settings to review it.",
    );
  return next;
}
