import type { InteractionObservation, InteractionPattern, InteractionSnapshot } from "../../shared";

export const ALIVE_POLICY_SCHEMA_VERSION = 1;
const MAX_RULES = 12;
const MAX_STRINGS = 12;
const MAX_STRING = 240;

export interface AliveTargetMatcher {
  interactionTypes?: string[];
  targetTags?: string[];
  targetIds?: string[];
  targetHints?: string[];
}

export interface AliveEventRule {
  id: string;
  description: string;
  match: AliveTargetMatcher;
}

export interface AliveReactionDescriptor {
  id: string;
  label: string;
  kind: "suggest" | "highlight" | "offer-existing-action";
  reversible: true;
  match?: AliveTargetMatcher;
}

export interface AlivePolicyProposal {
  meaningfulEvents: AliveEventRule[];
  repeatableInteractions: AliveEventRule[];
  successSignals: string[];
  safeReactions: AliveReactionDescriptor[];
  invariants: string[];
  clarificationSignals: string[];
  agentSignals: string[];
  retainEvidence: string[];
}

export interface AlivePolicy extends AlivePolicyProposal {
  schemaVersion: typeof ALIVE_POLICY_SCHEMA_VERSION;
  revision: number;
  updatedAt: number;
}

export interface AlivePolicyContext {
  schemaVersion: typeof ALIVE_POLICY_SCHEMA_VERSION;
  revision: number;
  matchedMeaningfulEvents: string[];
  matchedRepeatableInteractions: string[];
  successSignals: string[];
  safeReactions: Array<Pick<AliveReactionDescriptor, "id" | "label" | "kind" | "reversible">>;
  invariants: string[];
  clarificationSignals: string[];
  agentSignals: string[];
  retainEvidence: string[];
}

function short(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function strings(value: unknown, max = MAX_STRINGS): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => short(item)).filter((item): item is string => Boolean(item)).slice(0, max);
}

function matcher(value: unknown): AliveTargetMatcher | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const match: AliveTargetMatcher = {
    interactionTypes: strings(record.interactionTypes, 8).map(item => item.toLowerCase()),
    targetTags: strings(record.targetTags, 8).map(item => item.toLowerCase()),
    targetIds: strings(record.targetIds, 8),
    targetHints: strings(record.targetHints, 8),
  };
  if (!match.interactionTypes?.length) delete match.interactionTypes;
  if (!match.targetTags?.length) delete match.targetTags;
  if (!match.targetIds?.length) delete match.targetIds;
  if (!match.targetHints?.length) delete match.targetHints;
  return Object.keys(match).length ? match : undefined;
}

function rules(value: unknown): AliveEventRule[] {
  if (!Array.isArray(value)) return [];
  const result: AliveEventRule[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, MAX_RULES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = short(record.id, 64);
    const description = short(record.description);
    const match = matcher(record.match);
    if (!id || ids.has(id) || !description || !match) continue;
    ids.add(id);
    result.push({ id, description, match });
  }
  return result;
}

function reactions(value: unknown): AliveReactionDescriptor[] {
  if (!Array.isArray(value)) return [];
  const result: AliveReactionDescriptor[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, MAX_RULES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = short(record.id, 64);
    const label = short(record.label);
    const kind = record.kind;
    if (!id || ids.has(id) || !label || (kind !== "suggest" && kind !== "highlight" && kind !== "offer-existing-action")) continue;
    ids.add(id);
    const match = matcher(record.match);
    result.push({ id, label, kind, reversible: true, ...(match ? { match } : {}) });
  }
  return result;
}

export function normalizeAlivePolicyProposal(value: unknown): AlivePolicyProposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const proposal: AlivePolicyProposal = {
    meaningfulEvents: rules(record.meaningfulEvents),
    repeatableInteractions: rules(record.repeatableInteractions),
    successSignals: strings(record.successSignals),
    safeReactions: reactions(record.safeReactions),
    invariants: strings(record.invariants),
    clarificationSignals: strings(record.clarificationSignals),
    agentSignals: strings(record.agentSignals),
    retainEvidence: strings(record.retainEvidence),
  };
  const useful = proposal.meaningfulEvents.length
    + proposal.repeatableInteractions.length
    + proposal.successSignals.length
    + proposal.safeReactions.length
    + proposal.invariants.length
    + proposal.clarificationSignals.length
    + proposal.agentSignals.length
    + proposal.retainEvidence.length;
  return useful ? proposal : undefined;
}

export function activateAlivePolicy(
  proposal: AlivePolicyProposal,
  previous: AlivePolicy | undefined,
  now = Date.now(),
): AlivePolicy {
  return {
    schemaVersion: ALIVE_POLICY_SCHEMA_VERSION,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: now,
    ...structuredClone(proposal),
  };
}

function targetValues(interaction: InteractionSnapshot): string[] {
  const state = interaction.actualTarget.state ?? {};
  return [
    interaction.actualTarget.id,
    state.name,
    state["aria-label"],
    state.title,
    state.type,
  ].filter((item): item is string => typeof item === "string")
    .map(item => item.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

export function aliveMatcherMatches(match: AliveTargetMatcher, interaction: InteractionSnapshot): boolean {
  if (match.interactionTypes?.length && !match.interactionTypes.includes(interaction.type.toLowerCase())) return false;
  if (match.targetTags?.length && !match.targetTags.includes(interaction.actualTarget.tag.toLowerCase())) return false;
  if (match.targetIds?.length && !match.targetIds.includes(interaction.actualTarget.id ?? "")) return false;
  if (match.targetHints?.length) {
    const values = targetValues(interaction);
    const hints = match.targetHints.map(item => item.toLowerCase());
    if (!hints.some(hint => values.includes(hint))) return false;
  }
  return true;
}

export function alivePolicyRepeatable(policy: AlivePolicy | undefined, interaction: InteractionSnapshot): boolean {
  return Boolean(policy?.repeatableInteractions.some(rule => aliveMatcherMatches(rule.match, interaction)));
}

export function selectAlivePolicyContext(
  policy: AlivePolicy | undefined,
  observation: InteractionObservation,
  pattern: InteractionPattern | undefined,
): AlivePolicyContext | undefined {
  if (!policy || policy.schemaVersion !== ALIVE_POLICY_SCHEMA_VERSION) return undefined;
  const meaningful = policy.meaningfulEvents.filter(rule => aliveMatcherMatches(rule.match, observation.interaction));
  const repeatable = policy.repeatableInteractions.filter(rule => aliveMatcherMatches(rule.match, observation.interaction));
  const reactions = policy.safeReactions.filter(reaction => !reaction.match || aliveMatcherMatches(reaction.match, observation.interaction));
  const hasSignal = meaningful.length || repeatable.length || reactions.length || pattern?.frustrationSignal;
  if (!hasSignal && !policy.invariants.length && !policy.clarificationSignals.length && !policy.agentSignals.length) return undefined;
  return {
    schemaVersion: ALIVE_POLICY_SCHEMA_VERSION,
    revision: policy.revision,
    matchedMeaningfulEvents: meaningful.map(rule => rule.description),
    matchedRepeatableInteractions: repeatable.map(rule => rule.description),
    successSignals: policy.successSignals.slice(0, 6),
    safeReactions: reactions.slice(0, 4).map(({ id, label, kind, reversible }) => ({ id, label, kind, reversible })),
    invariants: policy.invariants.slice(0, 6),
    clarificationSignals: policy.clarificationSignals.slice(0, 6),
    agentSignals: policy.agentSignals.slice(0, 6),
    retainEvidence: policy.retainEvidence.slice(0, 6),
  };
}

export function alivePolicyDiagnostic(policy: AlivePolicy): Record<string, unknown> {
  return {
    schemaVersion: policy.schemaVersion,
    revision: policy.revision,
    updatedAt: policy.updatedAt,
    meaningfulEvents: policy.meaningfulEvents.length,
    repeatableInteractions: policy.repeatableInteractions.length,
    successSignals: policy.successSignals.length,
    safeReactions: policy.safeReactions.length,
    invariants: policy.invariants.length,
    clarificationSignals: policy.clarificationSignals.length,
    agentSignals: policy.agentSignals.length,
    retainEvidence: policy.retainEvidence.length,
  };
}
