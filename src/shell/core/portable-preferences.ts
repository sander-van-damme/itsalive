import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_PORTABLE_PREFERENCE_QUESTION_SET_VERSION = "portable-preference-v1";
export const MAX_PORTABLE_PREFERENCES = 12;
export const MAX_PORTABLE_PROVENANCE = 8;

export type PortablePreferenceCategory =
  | "motion"
  | "layout-density"
  | "input-mode"
  | "explanation-detail"
  | "proactive-assistance";

export type PortablePreferenceValue =
  | "reduced-motion"
  | "compact-layout"
  | "spacious-layout"
  | "keyboard-first"
  | "concise-explanations"
  | "detailed-explanations"
  | "fewer-proactive-suggestions";

export type PortablePreferenceCandidateSource = "explicit-input" | "behavior-episode";

export interface PortablePreferenceCandidate {
  source: PortablePreferenceCandidateSource;
  sourceAppId: string;
  sourceRef: string;
  observedAt: number;
  evidence: string;
  occurrences: number;
}

export interface PortablePreferenceProvenance {
  source: PortablePreferenceCandidateSource;
  appId: string;
  ref: string;
  observedAt: number;
  occurrences: number;
}

export interface PortablePreferenceRecord {
  id: string;
  category: PortablePreferenceCategory;
  value: PortablePreferenceValue;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
  portabilityProbability: number;
  classificationConfidence: number;
  provenance: PortablePreferenceProvenance[];
}

export interface PortablePreferenceDecision {
  action: "promote" | "ignore" | "uncertain";
  reason: string;
  value?: PortablePreferenceValue;
  category?: PortablePreferenceCategory;
  portabilityProbability: number;
  classificationConfidence: number;
}

export interface PortablePreferenceApplication {
  id: string;
  category: PortablePreferenceCategory;
  value: PortablePreferenceValue;
  label: string;
  context: string;
  sourceAppIds: string[];
}

export const JEV_PORTABLE_PREFERENCE_QUESTIONS: JevQuestions = {
  portable_preference: {
    type: "noul",
    instructions: "Does this bounded evidence support a stable preference that is likely to be useful across unrelated apps, rather than an app-specific task/history detail? Do not infer health, disability, identity, personality, or other sensitive traits.",
    criteria: {
      true: "The evidence directly supports one of the allowlisted portable UI/interaction preferences and is not tied to one app-specific task.",
      false: "The evidence is app-specific, ambiguous, transient, task history, or would require inferring a user trait beyond the allowlist.",
    },
  },
  portable_preference_value: {
    type: "choice",
    instructions: "Choose exactly one allowlisted portable preference supported by the evidence, or none. Never infer medical, disability, identity, personality, demographic, or other sensitive traits.",
    criteria: {
      reduced_motion: "The user clearly prefers less non-essential motion/animation.",
      compact_layout: "The user clearly prefers denser/compact spacing or information layout.",
      spacious_layout: "The user clearly prefers more spacious layout/spacing.",
      keyboard_first: "The user clearly prefers keyboard-first or keyboard-efficient interaction.",
      concise_explanations: "The user clearly prefers concise explanations/instructions.",
      detailed_explanations: "The user clearly prefers more detailed explanations/instructions.",
      fewer_proactive_suggestions: "The user clearly prefers fewer unsolicited/proactive suggestions.",
      none: "No allowlisted portable preference is strongly supported.",
    },
  },
};

const VALUE_TO_CATEGORY: Readonly<Record<PortablePreferenceValue, PortablePreferenceCategory>> = Object.freeze({
  "reduced-motion": "motion",
  "compact-layout": "layout-density",
  "spacious-layout": "layout-density",
  "keyboard-first": "input-mode",
  "concise-explanations": "explanation-detail",
  "detailed-explanations": "explanation-detail",
  "fewer-proactive-suggestions": "proactive-assistance",
});

const LABELS: Readonly<Record<PortablePreferenceValue, string>> = Object.freeze({
  "reduced-motion": "Reduced motion",
  "compact-layout": "Compact layout",
  "spacious-layout": "Spacious layout",
  "keyboard-first": "Keyboard-first interaction",
  "concise-explanations": "Concise explanations",
  "detailed-explanations": "Detailed explanations",
  "fewer-proactive-suggestions": "Fewer proactive suggestions",
});

const CONTEXT: Readonly<Record<PortablePreferenceValue, string>> = Object.freeze({
  "reduced-motion": "Prefer reduced non-essential motion and honor prefers-reduced-motion; do not remove necessary state feedback.",
  "compact-layout": "Prefer compact spacing and information density when it does not reduce clarity, target size, or accessibility.",
  "spacious-layout": "Prefer more spacious layout and separation when practical without hiding required information.",
  "keyboard-first": "Prefer keyboard-efficient interaction, semantic controls, predictable focus order, and visible focus while preserving pointer access.",
  "concise-explanations": "Prefer concise user-facing explanations and instructions while preserving essential information.",
  "detailed-explanations": "Prefer more detailed user-facing explanations and instructions when the app presents guidance.",
  "fewer-proactive-suggestions": "Prefer fewer unsolicited suggestions or helper prompts; avoid adding proactive UI unless the current task requires it.",
});

const VALUES = new Set<PortablePreferenceValue>(Object.keys(VALUE_TO_CATEGORY) as PortablePreferenceValue[]);

function compact(value: string, max = 1_200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function portablePreferenceCategory(value: PortablePreferenceValue): PortablePreferenceCategory {
  return VALUE_TO_CATEGORY[value];
}

export function portablePreferenceLabel(value: PortablePreferenceValue): string {
  return LABELS[value];
}

export function portablePreferenceContext(value: PortablePreferenceValue): string {
  return CONTEXT[value];
}

export function isPortablePreferenceValue(value: unknown): value is PortablePreferenceValue {
  return typeof value === "string" && VALUES.has(value as PortablePreferenceValue);
}

export function eligiblePortablePreferenceCandidate(candidate: PortablePreferenceCandidate): boolean {
  if (!candidate.sourceAppId || !candidate.sourceRef || !compact(candidate.evidence)) return false;
  if (candidate.source === "explicit-input") return true;
  return candidate.occurrences >= 2;
}

export function decidePortablePreference(
  result: Pick<JevDecisionResult, "answers">,
  minimumPortability = 0.9,
  minimumClassificationConfidence = 0.85,
): PortablePreferenceDecision {
  const portable = result.answers.portable_preference;
  const choice = result.answers.portable_preference_value;
  if (portable?.type !== "noul" || choice?.type !== "choice") {
    throw new Error("Jev portable preference response omitted required Noul/Choice answers");
  }
  const portabilityProbability = portable.noul;
  const classificationConfidence = choice.confidence;
  if (portabilityProbability < minimumPortability || choice.choice === "none") {
    return {
      action: "ignore",
      reason: choice.choice === "none" ? "no-allowlisted-preference" : "portability-below-threshold",
      portabilityProbability,
      classificationConfidence,
    };
  }
  const normalized = choice.choice.replaceAll("_", "-");
  if (classificationConfidence < minimumClassificationConfidence || !isPortablePreferenceValue(normalized)) {
    return {
      action: "uncertain",
      reason: "portable-preference-class-uncertain",
      portabilityProbability,
      classificationConfidence,
    };
  }
  return {
    action: "promote",
    reason: "allowlisted-portable-preference",
    value: normalized,
    category: portablePreferenceCategory(normalized),
    portabilityProbability,
    classificationConfidence,
  };
}

export function mergePortablePreference(
  records: readonly PortablePreferenceRecord[],
  candidate: PortablePreferenceCandidate,
  decision: PortablePreferenceDecision,
  id: string,
  now = Date.now(),
): PortablePreferenceRecord[] {
  if (decision.action !== "promote" || !decision.value || !decision.category) return [...records];
  const provenance: PortablePreferenceProvenance = {
    source: candidate.source,
    appId: candidate.sourceAppId,
    ref: candidate.sourceRef,
    observedAt: candidate.observedAt,
    occurrences: Math.max(1, Math.floor(candidate.occurrences)),
  };
  const match = records.find(item => item.category === decision.category && item.value === decision.value);
  const next = match
    ? {
        ...match,
        updatedAt: now,
        portabilityProbability: Math.max(match.portabilityProbability, decision.portabilityProbability),
        classificationConfidence: Math.max(match.classificationConfidence, decision.classificationConfidence),
        provenance: [
          provenance,
          ...match.provenance.filter(item => !(item.appId === provenance.appId && item.ref === provenance.ref)),
        ].slice(0, MAX_PORTABLE_PROVENANCE),
      }
    : {
        id,
        category: decision.category,
        value: decision.value,
        createdAt: now,
        updatedAt: now,
        enabled: true,
        portabilityProbability: decision.portabilityProbability,
        classificationConfidence: decision.classificationConfidence,
        provenance: [provenance],
      };
  return [next, ...records.filter(item => item.id !== next.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PORTABLE_PREFERENCES);
}

export function setPortablePreferenceEnabled(
  records: readonly PortablePreferenceRecord[],
  id: string,
  enabled: boolean,
  now = Date.now(),
): PortablePreferenceRecord[] {
  return records.map(item => item.id === id ? { ...item, enabled, updatedAt: now } : item);
}

export function removePortablePreferenceProvenance(
  records: readonly PortablePreferenceRecord[],
  appId: string,
): PortablePreferenceRecord[] {
  return records
    .map(item => ({ ...item, provenance: item.provenance.filter(source => source.appId !== appId) }))
    .filter(item => item.provenance.length > 0);
}

export function selectPortablePreferencesForApp(
  records: readonly PortablePreferenceRecord[],
  targetAppId: string,
  enabled: boolean,
  isolated: boolean,
): PortablePreferenceApplication[] {
  if (!enabled || isolated) return [];
  const crossApp = records.filter(item =>
    item.enabled
    && item.provenance.some(source => source.appId !== targetAppId)
  );
  const byCategory = new Map<PortablePreferenceCategory, PortablePreferenceRecord[]>();
  for (const item of crossApp) {
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  }
  const selected: PortablePreferenceApplication[] = [];
  for (const [category, bucket] of byCategory) {
    const distinct = new Set(bucket.map(item => item.value));
    if (distinct.size !== 1) continue;
    const record = [...bucket].sort((a, b) =>
      b.classificationConfidence - a.classificationConfidence || b.updatedAt - a.updatedAt
    )[0]!;
    selected.push({
      id: record.id,
      category,
      value: record.value,
      label: portablePreferenceLabel(record.value),
      context: portablePreferenceContext(record.value),
      sourceAppIds: [...new Set(record.provenance.map(item => item.appId))],
    });
  }
  return selected.sort((a, b) => a.category.localeCompare(b.category));
}

function validProvenance(value: unknown): value is PortablePreferenceProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.source === "explicit-input" || row.source === "behavior-episode")
    && typeof row.appId === "string" && row.appId.length > 0
    && typeof row.ref === "string" && row.ref.length > 0
    && typeof row.observedAt === "number" && Number.isFinite(row.observedAt)
    && typeof row.occurrences === "number" && Number.isFinite(row.occurrences);
}

export function parsePortablePreferences(value: unknown): PortablePreferenceRecord[] {
  if (!Array.isArray(value)) return [];
  const parsed: PortablePreferenceRecord[] = [];
  for (const item of value.slice(0, MAX_PORTABLE_PREFERENCES)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !isPortablePreferenceValue(row.value)) continue;
    const category = portablePreferenceCategory(row.value);
    if (row.category !== category || typeof row.enabled !== "boolean") continue;
    if (typeof row.createdAt !== "number" || typeof row.updatedAt !== "number") continue;
    if (typeof row.portabilityProbability !== "number" || typeof row.classificationConfidence !== "number") continue;
    const provenance = Array.isArray(row.provenance)
      ? row.provenance.filter(validProvenance).slice(0, MAX_PORTABLE_PROVENANCE)
      : [];
    if (!provenance.length) continue;
    parsed.push({
      id: row.id,
      category,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      enabled: row.enabled,
      portabilityProbability: Math.max(0, Math.min(1, row.portabilityProbability)),
      classificationConfidence: Math.max(0, Math.min(1, row.classificationConfidence)),
      provenance,
    });
  }
  return parsed.sort((a, b) => b.updatedAt - a.updatedAt);
}
