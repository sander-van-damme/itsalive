import type { InteractionObservation, InteractionPattern, InteractionSnapshot, JevState } from "../../shared";

const RECENT_LIMIT = 12;
const RAPID_REPEAT_AVERAGE_MS = 450;
const FRUSTRATION_ACTION_COUNT = 5;
export const MAX_BEHAVIOR_SUMMARY_CHARACTERS = 8_000;

interface AppBehaviorState {
  recent: InteractionSnapshot[];
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

  observe(appId: string, observation: InteractionObservation, historySummary?: string): JevState {
    const state = this.state(appId);
    state.recent.push(observation.interaction);
    if (state.recent.length > RECENT_LIMIT) state.recent.shift();

    const pattern = interpretInteractionPattern(observation);
    return {
      interaction: observation.interaction,
      recentInteractions: [...state.recent],
      ...(pattern ? { pattern } : {}),
      ...(historySummary?.trim() ? { historySummary: historySummary.trim().slice(0, MAX_BEHAVIOR_SUMMARY_CHARACTERS) } : {}),
      document: observation.document,
    };
  }

  clear(appId: string): void {
    this.apps.delete(appId);
  }

  private state(appId: string): AppBehaviorState {
    let state = this.apps.get(appId);
    if (!state) {
      state = { recent: [] };
      this.apps.set(appId, state);
    }
    return state;
  }
}
