import type { InteractionObservation, InteractionPattern, InteractionSnapshot } from "../../shared";
import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_ACCESSIBILITY_FRICTION_QUESTION_SET_VERSION = "accessibility-friction-v1";
export const ACCESSIBILITY_DISMISSAL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_ACCESSIBILITY_DISMISSALS = 12;

export type AccessibilityFrictionKind =
  | "keyboard-semantics"
  | "targeting"
  | "feedback"
  | "navigation";

export interface AccessibilityDismissal {
  key: string;
  dismissedAt: number;
  until: number;
}

export interface AccessibilitySuggestionCandidate {
  key: string;
  kind: AccessibilityFrictionKind;
  source: "deterministic" | "jev";
  content: string;
  applyLabel: string;
  requestText: string;
  hypothesis: string;
  intendedOutcome: string;
  evidence: {
    interactionType: string;
    targetTag: string;
    targetId?: string;
    key?: string;
    actionCount?: number;
    documentChangeCount?: number;
  };
}

export interface AmbiguousAccessibilityCandidate {
  key: string;
  interactionType: string;
  targetTag: string;
  targetId?: string;
  targetRole?: string;
  targetLabel?: string;
  actionCount: number;
  documentChangeCount: number;
}

export const JEV_ACCESSIBILITY_FRICTION_QUESTIONS: JevQuestions = {
  accessibility_friction: {
    type: "noul",
    instructions: "Given this bounded repeated interaction evidence, is there meaningful user-interface friction where a concrete accessibility-oriented UI adjustment is likely to help? Do not infer a disability or health condition.",
    criteria: {
      true: "Repeated interaction plus lack of observable progress plausibly indicates targeting, feedback, or navigation friction.",
      false: "The behavior is ordinary/repeatable use, too weak to interpret, or does not support an accessibility-oriented adjustment.",
    },
  },
  accessibility_friction_kind: {
    type: "choice",
    instructions: "Classify the narrow observable UI friction. Do not infer user traits or diagnoses.",
    criteria: {
      targeting: "The control appears difficult to activate/target reliably and a larger/clearer interactive target could help.",
      feedback: "The action lacks clear perceivable success/error feedback, causing repeated attempts.",
      navigation: "The interaction path/focus/navigation appears unnecessarily difficult or indirect.",
      none: "No supported accessibility-oriented friction class is present.",
    },
  },
};

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "textbox", "combobox", "option", "menuitem", "tab", "slider", "spinbutton"]);

function stateValue(snapshot: InteractionSnapshot, name: string): string | undefined {
  const value = snapshot.actualTarget.state?.[name];
  return typeof value === "string" ? value.trim() : undefined;
}

function targetKey(snapshot: InteractionSnapshot): string {
  const target = snapshot.actualTarget;
  const identity = target.id || stateValue(snapshot, "aria-label") || stateValue(snapshot, "title") || stateValue(snapshot, "name") || target.tag;
  return [target.tag, identity].join(":").toLowerCase().slice(0, 300);
}

function targetDescription(snapshot: InteractionSnapshot): string {
  const target = snapshot.actualTarget;
  return (stateValue(snapshot, "aria-label") || stateValue(snapshot, "title") || target.id || target.tag).slice(0, 160);
}

function isSemanticallyInteractive(snapshot: InteractionSnapshot): boolean {
  const tag = snapshot.actualTarget.tag.toLowerCase();
  const role = stateValue(snapshot, "role")?.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === "a" && Boolean(snapshot.actualTarget.state?.href)) return true;
  return Boolean(role && INTERACTIVE_ROLES.has(role));
}

function isRepeatable(snapshot: InteractionSnapshot): boolean {
  const state = snapshot.actualTarget.state;
  return state?.["data-itsalive-repeatable"] === "true"
    || state?.["data-repeatable"] === "true";
}

export function deterministicAccessibilitySuggestion(
  observation: InteractionObservation,
  pattern?: InteractionPattern,
): AccessibilitySuggestionCandidate | undefined {
  const interaction = observation.interaction;
  if (interaction.type !== "keydown") return undefined;
  if (interaction.key !== "Enter" && interaction.key !== " ") return undefined;
  if (isSemanticallyInteractive(interaction)) return undefined;
  if (!pattern || pattern.actionCount < 2 || pattern.documentChangeCount > 0) return undefined;

  const descriptor = targetDescription(interaction);
  const key = "keyboard-semantics:" + targetKey(interaction);
  return {
    key,
    kind: "keyboard-semantics",
    source: "deterministic",
    content: `Keyboard activation on “${descriptor}” is not producing a result, and the target is not a semantic interactive control. Make it keyboard-accessible and keep focus clear after activation?`,
    applyLabel: "Improve keyboard access",
    requestText: `Apply this accessibility adjustment to “${descriptor}”: use native semantic interactive HTML where practical; make Enter/Space activation work; keep visible keyboard focus stable after activation; preserve pointer behavior, current data, and reduced-motion behavior; do not change unrelated layout.`,
    hypothesis: `Repeated keyboard activation on “${descriptor}” is failing because the target is not semantically interactive.`,
    intendedOutcome: `“${descriptor}” can be reached and activated with the keyboard, has clear visible focus, and keeps its existing pointer behavior.`,
    evidence: {
      interactionType: interaction.type,
      targetTag: interaction.actualTarget.tag,
      ...(interaction.actualTarget.id ? { targetId: interaction.actualTarget.id } : {}),
      key: interaction.key,
      actionCount: pattern.actionCount,
      documentChangeCount: pattern.documentChangeCount,
    },
  };
}

export function ambiguousAccessibilityCandidate(
  observation: InteractionObservation,
  pattern?: InteractionPattern,
): AmbiguousAccessibilityCandidate | undefined {
  const interaction = observation.interaction;
  if (interaction.type !== "click") return undefined;
  if (!pattern || pattern.actionCount < 4 || pattern.documentChangeCount > 0 || pattern.likelyBenign) return undefined;
  if (isRepeatable(interaction)) return undefined;
  return {
    key: "pointer-friction:" + targetKey(interaction),
    interactionType: interaction.type,
    targetTag: interaction.actualTarget.tag,
    ...(interaction.actualTarget.id ? { targetId: interaction.actualTarget.id } : {}),
    ...(stateValue(interaction, "role") ? { targetRole: stateValue(interaction, "role") } : {}),
    ...(stateValue(interaction, "aria-label") || stateValue(interaction, "title")
      ? { targetLabel: stateValue(interaction, "aria-label") || stateValue(interaction, "title") }
      : {}),
    actionCount: pattern.actionCount,
    documentChangeCount: pattern.documentChangeCount,
  };
}

export interface AccessibilityFrictionDecision {
  action: "offer" | "ignore" | "uncertain";
  kind?: Exclude<AccessibilityFrictionKind, "keyboard-semantics">;
  probability: number;
  confidence: number;
  reason: string;
}

export function decideAccessibilityFriction(
  result: Pick<JevDecisionResult, "answers">,
  probabilityThreshold = 0.75,
  confidenceThreshold = 0.7,
): AccessibilityFrictionDecision {
  const friction = result.answers.accessibility_friction;
  const kind = result.answers.accessibility_friction_kind;
  if (friction?.type !== "noul" || kind?.type !== "choice") {
    throw new Error("Jev accessibility response omitted required Noul/Choice answers");
  }
  if (kind.choice === "none" || friction.noul < probabilityThreshold) {
    return { action: "ignore", probability: friction.noul, confidence: kind.confidence, reason: "friction-not-supported" };
  }
  if (kind.confidence < confidenceThreshold || !["targeting", "feedback", "navigation"].includes(kind.choice)) {
    return { action: "uncertain", probability: friction.noul, confidence: kind.confidence, reason: "friction-class-uncertain" };
  }
  return {
    action: "offer",
    kind: kind.choice as "targeting" | "feedback" | "navigation",
    probability: friction.noul,
    confidence: kind.confidence,
    reason: "bounded-friction-supported",
  };
}

export function accessibilitySuggestionFromJev(
  candidate: AmbiguousAccessibilityCandidate,
  decision: AccessibilityFrictionDecision,
): AccessibilitySuggestionCandidate | undefined {
  if (decision.action !== "offer" || !decision.kind) return undefined;
  const descriptor = candidate.targetLabel || candidate.targetId || candidate.targetTag;
  const commonEvidence = {
    interactionType: candidate.interactionType,
    targetTag: candidate.targetTag,
    ...(candidate.targetId ? { targetId: candidate.targetId } : {}),
    actionCount: candidate.actionCount,
    documentChangeCount: candidate.documentChangeCount,
  };
  if (decision.kind === "targeting") {
    return {
      key: candidate.key + ":targeting",
      kind: "targeting",
      source: "jev",
      content: `“${descriptor}” is being retried without a visible result. Make this control easier to target and give it a clear focus/active state?`,
      applyLabel: "Improve this control",
      requestText: `Apply this accessibility adjustment to “${descriptor}”: make the interactive target easier to activate without changing its meaning; prefer semantic native controls; preserve keyboard operation and visible focus; preserve reduced-motion behavior and unrelated layout.`,
      hypothesis: `Repeated unchanged interaction suggests “${descriptor}” may be difficult to target reliably.`,
      intendedOutcome: `“${descriptor}” is easier to activate by pointer and keyboard without accidental layout or behavior changes.`,
      evidence: commonEvidence,
    };
  }
  if (decision.kind === "feedback") {
    return {
      key: candidate.key + ":feedback",
      kind: "feedback",
      source: "jev",
      content: `“${descriptor}” is being retried without a visible result. Add clearer success/error feedback after this action?`,
      applyLabel: "Improve feedback",
      requestText: `Apply this accessibility adjustment to “${descriptor}”: add clear perceivable success/error feedback after activation, using semantic status/error markup where practical; preserve keyboard focus, reduced-motion behavior, current data, and unrelated layout.`,
      hypothesis: `Repeated unchanged interaction suggests the result of “${descriptor}” may not be perceivable enough.`,
      intendedOutcome: `After using “${descriptor}”, the result is clearly perceivable without requiring repeated attempts.`,
      evidence: commonEvidence,
    };
  }
  return {
    key: candidate.key + ":navigation",
    kind: "navigation",
    source: "jev",
    content: `Repeated attempts around “${descriptor}” suggest the interaction path may be harder than necessary. Simplify keyboard/focus navigation around this control?`,
    applyLabel: "Improve navigation",
    requestText: `Apply this accessibility adjustment around “${descriptor}”: simplify the interaction path and focus order using semantic HTML; keep keyboard focus visible and predictable; preserve pointer behavior, reduced-motion behavior, current data, and unrelated layout.`,
    hypothesis: `Repeated unchanged interaction suggests navigation around “${descriptor}” may be unnecessarily difficult.`,
    intendedOutcome: `The path to and from “${descriptor}” is simpler and keyboard focus remains predictable.`,
    evidence: commonEvidence,
  };
}

export function shouldSuppressAccessibilitySuggestion(
  dismissals: readonly AccessibilityDismissal[] | undefined,
  key: string,
  now = Date.now(),
): boolean {
  return Boolean(dismissals?.some(item => item.key === key && item.until > now));
}

export function recordAccessibilityDismissal(
  dismissals: readonly AccessibilityDismissal[] | undefined,
  key: string,
  now = Date.now(),
): AccessibilityDismissal[] {
  const entry = { key, dismissedAt: now, until: now + ACCESSIBILITY_DISMISSAL_MS };
  return [entry, ...(dismissals ?? []).filter(item => item.key !== key && item.until > now)]
    .sort((a, b) => b.dismissedAt - a.dismissedAt)
    .slice(0, MAX_ACCESSIBILITY_DISMISSALS);
}
