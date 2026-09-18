import type { JevState } from "../../shared";

export interface ReactionBatch { events: JevState[]; createdAt: number; }
export const DEFAULT_REACTION_WINDOW_MS = 500;

export function formatReactionBatch(batch: ReactionBatch): string {
  const events = [...batch.events].sort((a, b) => a.interaction.seq - b.interaction.seq);
  const recent = new Map<number, JevState["interaction"]>();
  for (const state of events) for (const interaction of state.recentInteractions) recent.set(interaction.seq, interaction);
  return `AUTOMATIC INTERACTION REACTION\n\nOne or more recent interactions were flagged by the fast observer as possibly requiring intelligent attention. The events may be related, unrelated, require no work, one work item, or several. Determine the useful response.\n\nESCALATED EVENTS\n${JSON.stringify(events.map(event => ({ interaction: event.interaction, ...(event.pattern ? { pattern: event.pattern } : {}) })), null, 2)}\n\nCOMPACT BEHAVIORAL HISTORY\n${events.at(-1)?.historySummary ?? "(none)"}\n\nSURROUNDING RECENT INTERACTIONS\n${JSON.stringify([...recent.values()].sort((a, b) => a.seq - b.seq), null, 2)}\n\nNEWEST SEMANTIC DOCUMENT\n${events.at(-1)?.document ?? ""}`;
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
