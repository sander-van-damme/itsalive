import type { JevState } from "../../shared";

export interface ReactionBatch { events: JevState[]; createdAt: number; }
export const DEFAULT_REACTION_WINDOW_MS = 500;

export function formatReactionBatch(batch: ReactionBatch): string {
  return `AUTOMATIC INTERACTION REACTION\n\nOne or more recent interactions were flagged by the fast observer as possibly requiring intelligent attention. The events may or may not be related. Determine whether anything should change. If nothing useful should happen, make no change.\n\nEVENTS\n${JSON.stringify(batch.events.map(event => event.interaction), null, 2)}\n\nCURRENT RELEVANT STATE\n${batch.events.at(-1)?.document ?? ""}`;
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
    const events = this.pending.splice(0);
    console.info("[itsalive:reaction] Reaction batch ready", { size: events.length });
    await this.deliver({ events, createdAt: Date.now() });
  }
  destroy(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending = []; }
}

