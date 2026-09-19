import type { JevState } from "../../shared";

export interface ReactionBatch { events: JevState[]; createdAt: number; }
export interface ReactionConfirmation { id: string; key: string; batch: ReactionBatch; createdAt: number; }
export type ReactionOfferResult =
  | { kind: "prompt"; confirmation: ReactionConfirmation }
  | { kind: "duplicate"; confirmation: ReactionConfirmation }
  | { kind: "pending"; confirmation: ReactionConfirmation }
  | { kind: "cooldown"; key: string; until: number };
export type ReactionResolution =
  | { kind: "confirmed"; confirmation: ReactionConfirmation; intent: string }
  | { kind: "dismissed"; confirmation: ReactionConfirmation }
  | { kind: "missing" };

export const DEFAULT_REACTION_WINDOW_MS = 500;
export const DEFAULT_REACTION_CONFIRMATION_COOLDOWN_MS = 5 * 60_000;

function compactHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function reactionBatchFingerprint(batch: ReactionBatch): string {
  const newest = [...batch.events].sort((a, b) => a.interaction.seq - b.interaction.seq).at(-1);
  if (!newest) return "empty";
  const interaction = newest.interaction;
  const target = interaction.actualTarget ?? interaction.target;
  const pattern = newest.pattern;
  return [
    interaction.type,
    target.tag,
    target.id ?? "",
    interaction.key ?? "",
    pattern?.kind ?? "",
    pattern?.frustrationSignal ? "frustration" : "",
    compactHash(newest.document),
  ].join("|");
}

export function interactionConfirmationMessage(batch: ReactionBatch): string {
  const newest = [...batch.events].sort((a, b) => a.interaction.seq - b.interaction.seq).at(-1);
  if (newest?.pattern?.frustrationSignal) {
    return "It looks like you tried the same thing several times without getting the response you expected. What were you trying to make happen?";
  }
  return "I noticed an interaction that may not have done what you expected. What were you trying to make happen?";
}

export class ReactionConfirmationGate {
  private pending?: ReactionConfirmation;
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly cooldownMs = DEFAULT_REACTION_CONFIRMATION_COOLDOWN_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  current(): ReactionConfirmation | undefined { return this.pending; }

  offer(batch: ReactionBatch): ReactionOfferResult {
    const key = reactionBatchFingerprint(batch);
    const now = this.now();
    const until = this.cooldownUntil.get(key) ?? 0;
    if (until > now) return { kind: "cooldown", key, until };
    if (until) this.cooldownUntil.delete(key);

    if (this.pending) {
      return this.pending.key === key
        ? { kind: "duplicate", confirmation: this.pending }
        : { kind: "pending", confirmation: this.pending };
    }

    const confirmation: ReactionConfirmation = { id: this.createId(), key, batch, createdAt: now };
    this.pending = confirmation;
    return { kind: "prompt", confirmation };
  }

  resolve(id: string, intent?: string): ReactionResolution {
    const confirmation = this.pending;
    if (!confirmation || confirmation.id !== id) return { kind: "missing" };
    this.pending = undefined;
    this.cooldownUntil.set(confirmation.key, this.now() + this.cooldownMs);
    const normalizedIntent = intent?.trim();
    return normalizedIntent
      ? { kind: "confirmed", confirmation, intent: normalizedIntent }
      : { kind: "dismissed", confirmation };
  }

  clear(): void { this.pending = undefined; }
}

export function formatReactionBatch(batch: ReactionBatch, intent: string): string {
  const events = [...batch.events].sort((a, b) => a.interaction.seq - b.interaction.seq);
  const recent = new Map<number, JevState["interaction"]>();
  for (const state of events) for (const interaction of state.recentInteractions) recent.set(interaction.seq, interaction);
  return `USER CONFIRMED INTERACTION INTENT

The user explicitly described the outcome they wanted from the observed interaction. Treat this intent as authoritative and use the telemetry only as supporting evidence. Make the smallest useful, reversible change that satisfies the stated intent; do not infer additional goals.

USER INTENT
${intent.trim()}

ESCALATED EVENTS
${JSON.stringify(events.map(event => ({ interaction: event.interaction, ...(event.pattern ? { pattern: event.pattern } : {}) })), null, 2)}

COMPACT BEHAVIORAL HISTORY
${events.at(-1)?.historySummary ?? "(none)"}

SURROUNDING RECENT INTERACTIONS
${JSON.stringify([...recent.values()].sort((a, b) => a.seq - b.seq), null, 2)}

NEWEST SEMANTIC DOCUMENT
${events.at(-1)?.document ?? ""}`;
}

export class ReactionBatcher {
  private pending: JevState[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly deliver: (batch: ReactionBatch) => void | Promise<void>, private readonly windowMs = DEFAULT_REACTION_WINDOW_MS) {}
  add(state: JevState): void {
    this.pending.push(state);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.windowMs);
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.pending.length) return;
    const events = this.pending.splice(0).sort((a, b) => a.interaction.seq - b.interaction.seq);
    console.info("[itsalive:reaction] Reaction batch ready", { size: events.length });
    await this.deliver({ events, createdAt: Date.now() });
  }
  destroy(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending = []; }
}
