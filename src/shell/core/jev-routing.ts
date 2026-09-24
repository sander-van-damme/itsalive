import type { JevDecisionResult, JevQuestions } from "./jev";

export const JEV_TRIGGER_ROUTING_QUESTION_SET_VERSION = "trigger-routing-v1";

export type TriggerRoute =
  | "modify"
  | "debug"
  | "inspect"
  | "answer"
  | "context"
  | "clarify"
  | "no_action";

export type CodingProfileRoute = "implementation" | "repair" | "none";

export const JEV_TRIGGER_ROUTING_QUESTIONS: JevQuestions = {
  trigger_route: {
    type: "choice",
    instructions: "Classify the bounded trigger into the single downstream route that best describes what kind of handling it needs. Do not invent a plan or answer the user.",
    criteria: {
      modify: "A requested feature, edit, addition, removal, or behavior change that needs implementation.",
      debug: "A broken, failing, erroneous, or unexpectedly behaving app state where repair/diagnosis is the main task.",
      inspect: "The trigger primarily asks to inspect/check existing state before deciding whether anything should change.",
      answer: "The trigger is primarily a question requiring a user-facing answer rather than app mutation.",
      context: "The input is explanatory context, feedback, preference, or observation that does not itself authorize a change.",
      clarify: "The input is too ambiguous to determine the intended downstream task without clarification.",
      no_action: "No intelligent/generative follow-up is warranted from this trigger.",
    },
  },
  coding_profile: {
    type: "choice",
    instructions: "If coding work is required, choose the existing worker profile family that best matches the dominant task. Otherwise choose none.",
    criteria: {
      implementation: "The work is primarily building or modifying intended app behavior.",
      repair: "The work is primarily diagnosing/fixing broken or erroneous existing behavior.",
      none: "No coding worker profile is appropriate for this trigger.",
    },
  },
};

export interface TriggerRoutingPolicy {
  minimumRouteConfidence: number;
  minimumProfileConfidence: number;
  runtimeNoActionConfidence: number;
}

export const DEFAULT_TRIGGER_ROUTING_POLICY: TriggerRoutingPolicy = Object.freeze({
  minimumRouteConfidence: 0.75,
  minimumProfileConfidence: 0.7,
  runtimeNoActionConfidence: 0.9,
});

export interface TriggerRoutingDecision {
  route: TriggerRoute;
  routeConfidence: number;
  profileRoute: CodingProfileRoute;
  profileConfidence: number;
  confident: boolean;
  preferredWorkerProfile?: "component-worker" | "repair-worker";
}

export function decideTriggerRouting(
  result: Pick<JevDecisionResult, "answers">,
  policy: TriggerRoutingPolicy = DEFAULT_TRIGGER_ROUTING_POLICY,
): TriggerRoutingDecision {
  const route = result.answers.trigger_route;
  const profile = result.answers.coding_profile;
  if (route?.type !== "choice" || profile?.type !== "choice") {
    throw new Error("Jev trigger routing response omitted required Choice answers");
  }
  const validRoutes: TriggerRoute[] = ["modify", "debug", "inspect", "answer", "context", "clarify", "no_action"];
  const validProfiles: CodingProfileRoute[] = ["implementation", "repair", "none"];
  if (!validRoutes.includes(route.choice as TriggerRoute) || !validProfiles.includes(profile.choice as CodingProfileRoute)) {
    throw new Error("Jev trigger routing returned an unsupported route");
  }
  const routeName = route.choice as TriggerRoute;
  const profileRoute = profile.choice as CodingProfileRoute;
  const confident = route.confidence >= policy.minimumRouteConfidence;
  const preferredWorkerProfile = confident && profile.confidence >= policy.minimumProfileConfidence
    ? profileRoute === "repair"
      ? "repair-worker" as const
      : profileRoute === "implementation"
        ? "component-worker" as const
        : undefined
    : undefined;
  return {
    route: routeName,
    routeConfidence: route.confidence,
    profileRoute,
    profileConfidence: profile.confidence,
    confident,
    ...(preferredWorkerProfile ? { preferredWorkerProfile } : {}),
  };
}

export function shouldSkipRuntimeWake(
  decision: TriggerRoutingDecision,
  policy: TriggerRoutingPolicy = DEFAULT_TRIGGER_ROUTING_POLICY,
): boolean {
  return decision.route === "no_action"
    && decision.routeConfidence >= policy.runtimeNoActionConfidence
    && decision.profileRoute === "none";
}

export function routeAgreesWithIntent(
  route: TriggerRoute,
  intent: { kind: string; shouldCode: boolean },
): boolean {
  if (intent.shouldCode) return route === "modify" || route === "debug";
  if (intent.kind === "question") return route === "answer" || route === "inspect";
  if (intent.kind === "explanation" || intent.kind === "preference") return route === "context";
  return route === "context" || route === "clarify" || route === "no_action" || route === "answer";
}

export function routingMisrouteClass(
  route: TriggerRoute,
  intent: { kind: string; shouldCode: boolean },
): "agreement" | "missed-change" | "false-change" | "other-disagreement" {
  if (routeAgreesWithIntent(route, intent)) return "agreement";
  const routeCodes = route === "modify" || route === "debug";
  if (intent.shouldCode && !routeCodes) return "missed-change";
  if (!intent.shouldCode && routeCodes) return "false-change";
  return "other-disagreement";
}
