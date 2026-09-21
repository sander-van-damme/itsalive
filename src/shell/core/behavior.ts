import type { InteractionObservation, InteractionPattern, InteractionSnapshot, JevState } from "../../shared";

const RECENT_LIMIT = 12;
const MAX_REWRITE_QUEUE = 40;
const RAPID_REPEAT_AVERAGE_MS = 450;
const FRUSTRATION_ACTION_COUNT = 5;
export const DEFAULT_BEHAVIOR_REWRITE_INTERVAL = 12;
export const MAX_BEHAVIOR_SUMMARY_CHARACTERS = 8_000;

export interface BehavioralSample {
  interaction: InteractionSnapshot;
  pattern?: InteractionPattern;
}

interface AppBehaviorState {
  recent: InteractionSnapshot[];
  rewriteQueue: BehavioralSample[];
}

function targetHint(interaction: InteractionSnapshot): string {
  const target = interaction.actualTarget;
  const state = target.state ?? {};
  return [
    target.id,
    state.name,
    state["aria-label"],
    state.title,
    state.type,
  ].filter(value => typeof value === "string").join(" ").toLowerCase();
}

function explicitlyRepeatable(interaction: InteractionSnapshot): boolean {
  const target = interaction.actualTarget;
  const state = target.state ?? {};
  if (target.tag === "audio" || target.tag === "video") return true;
  if (target.tag === "input" && state.type === "range") return true;
  if (state["data-itsalive-repeatable"] !== undefined || state["data-repeatable"] !== undefined) return true;
  return /\b(?:play|pause|hear|listen|sound|audio|tone|note|chord|piano|drum|beat|preview|sample)\b/.test(targetHint(interaction));
}

export function interpretInteractionPattern(observation: InteractionObservation): InteractionPattern | undefined {
  const pattern = observation.pattern;
  if (!pattern) return undefined;
  const likelyBenign = explicitlyRepeatable(observation.interaction) || pattern.documentChangeCount > 0;
  return {
    ...pattern,
    likelyBenign,
    frustrationSignal: pattern.actionCount >= FRUSTRATION_ACTION_COUNT
      && pattern.averageIntervalMs <= RAPID_REPEAT_AVERAGE_MS
      && pattern.documentChangeCount === 0
      && !likelyBenign,
  };
}

export class BehaviorTracker {
  private readonly apps = new Map<string, AppBehaviorState>();

  constructor(private readonly rewriteInterval = DEFAULT_BEHAVIOR_REWRITE_INTERVAL) {}

  observe(appId: string, observation: InteractionObservation, historySummary?: string): JevState {
    const state = this.state(appId);
    state.recent.push(observation.interaction);
    if (state.recent.length > RECENT_LIMIT) state.recent.shift();

    const pattern = interpretInteractionPattern(observation);
    state.rewriteQueue.push({
      interaction: observation.interaction,
      ...(pattern ? { pattern } : {}),
    });
    if (state.rewriteQueue.length > MAX_REWRITE_QUEUE) state.rewriteQueue.splice(0, state.rewriteQueue.length - MAX_REWRITE_QUEUE);

    return {
      interaction: observation.interaction,
      recentInteractions: [...state.recent],
      ...(pattern ? { pattern } : {}),
      ...(historySummary?.trim() ? { historySummary: historySummary.trim().slice(0, MAX_BEHAVIOR_SUMMARY_CHARACTERS) } : {}),
      document: observation.document,
    };
  }

  hasRewriteBatch(appId: string): boolean {
    return (this.apps.get(appId)?.rewriteQueue.length ?? 0) >= this.rewriteInterval;
  }

  takeRewriteBatch(appId: string): BehavioralSample[] | undefined {
    const state = this.apps.get(appId);
    if (!state || state.rewriteQueue.length < this.rewriteInterval) return undefined;
    return state.rewriteQueue.splice(0);
  }

  restoreRewriteBatch(appId: string, batch: BehavioralSample[]): void {
    if (!batch.length) return;
    const state = this.state(appId);
    state.rewriteQueue = [...batch, ...state.rewriteQueue].slice(-MAX_REWRITE_QUEUE);
  }

  clear(appId: string): void {
    this.apps.delete(appId);
  }

  private state(appId: string): AppBehaviorState {
    let state = this.apps.get(appId);
    if (!state) {
      state = { recent: [], rewriteQueue: [] };
      this.apps.set(appId, state);
    }
    return state;
  }
}

export function behaviorRewritePrompt(existing: string | undefined, batch: BehavioralSample[]): string {
  return `Rewrite the behavioral history as one concise curated summary. Preserve durable preferences, recurring patterns, meaningful outcomes, and unresolved needs. Omit secrets and implementation noise. Do not reproduce event records or timestamps verbatim. Return only the rewritten summary.

Existing curated history:
${existing?.trim() || "(none)"}

New ephemeral interactions:
${JSON.stringify(batch)}`;
}
