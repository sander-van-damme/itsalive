export const PLATFORM_CAPABILITIES = [
  {
    id: "done",
    signature: "return agent.done('Ready')",
    purpose: "Signal that the current coding task is actually complete and optionally provide a short user-facing completion message.",
    whenToUse: "Use only from the final coding command after the requested outcome works and verification is complete.",
    whenNotToUse: "Do not use while staged UI is unfinished or while a repair/verification step remains.",
    example: "return agent.done('Ready to use.');",
  },
  {
    id: "ai",
    signature: "application.ai.text / choose / score / decide / probability",
    purpose: "Use shell-owned AI for generated text or simple bounded decisions without exposing provider/Jev details.",
    whenToUse: "Use text for generated content; choose for one bounded option; score for an ordered scale; decide for conservative yes/no/null; probability only when the numeric probability itself is useful.",
    whenNotToUse: "Do not use AI for deterministic browser logic. Do not implement your own confidence threshold; choose/score/decide already return null when uncertain.",
    example: [
      "text: await application.ai.text('Name this note') -> 'Trip ideas'",
      "choose: await application.ai.choose('Route?', { billing: 'Payments', technical: 'Broken feature' }, ticket) -> 'billing' | null",
      "score: await application.ai.score('Severity?', ['Low', 'Medium', 'High'], report) -> 1.2 | null",
      "decide: await application.ai.decide('Refund request?', message) -> true | false | null",
      "probability: await application.ai.probability('Refund request?', message) -> 0.93",
    ].join("\n"),
  },
  {
    id: "escalate",
    signature: "application.escalate(reason)",
    purpose: "Hand control to the external coding agent when the running app needs the app itself inspected or changed.",
    whenToUse: "Use sparingly when the app cannot solve the problem locally and a coding-agent run is genuinely required.",
    whenNotToUse: "Do not use when you need generated text or a bounded decision back in the current script; use application.ai instead.",
    example: "application.escalate('The imported schema changed. Inspect the app and adapt it.');",
  },
  {
    id: "memory",
    signature: "await agent.memory()",
    purpose: "Read curated shell-owned memory relevant to the current app without exposing raw history records.",
    whenToUse: "Use during coding when earlier app/user context is genuinely needed.",
    whenNotToUse: "Do not use as application state; durable app state belongs in application.store.",
    example: "const memory = await agent.memory();",
  },
  {
    id: "screenshot",
    signature: "await agent.screenshot()",
    purpose: "Capture a best-effort screenshot for visual verification while coding.",
    whenToUse: "Use when visual layout or rendering needs verification beyond DOM inspection.",
    whenNotToUse: "Do not block completion solely because screenshot capture is unavailable.",
    example: "const image = await agent.screenshot();",
  },
  {
    id: "store",
    signature: "application.store.namespace",
    purpose: "Keep ordinary serializable application state durable across reloads.",
    whenToUse: "Use for reasonably sized durable app state that should survive reloads.",
    whenNotToUse: "Use native IndexedDB directly for large, binary, or query-heavy datasets.",
    example: "application.store.counter ??= { count: 0 };",
  },
] as const;

export type PlatformCapabilityId = typeof PLATFORM_CAPABILITIES[number]["id"];

const CAPABILITY_IDS = new Set<string>(PLATFORM_CAPABILITIES.map(capability => capability.id));

export function isPlatformCapabilityId(value: string): value is PlatformCapabilityId {
  return CAPABILITY_IDS.has(value);
}

export function platformCapabilityIndex(): string {
  return PLATFORM_CAPABILITIES
    .map(capability => `- ${capability.id}: ${capability.signature} — ${capability.purpose}`)
    .join("\n");
}

export function platformCapabilityHelp(ids: readonly PlatformCapabilityId[]): string {
  const selected = new Set(ids);
  const capabilities = PLATFORM_CAPABILITIES.filter(capability => selected.has(capability.id));
  if (!capabilities.length) return "(none selected)";
  return capabilities.map(capability => [
    `${capability.id} — ${capability.signature}`,
    `Purpose: ${capability.purpose}`,
    `Use when: ${capability.whenToUse}`,
    `Do not use when: ${capability.whenNotToUse}`,
    `Example: ${capability.example}`,
  ].join("\n")).join("\n\n");
}

export function inferPlatformCapabilities(text: string): PlatformCapabilityId[] {
  const lower = text.toLocaleLowerCase();
  const ids: PlatformCapabilityId[] = [];
  const add = (id: PlatformCapabilityId, matches: boolean) => { if (matches && !ids.includes(id)) ids.push(id); };

  add("ai", /\b(poem|story|haiku|lyrics?|generate (?:text|copy|content|an? answer)|write (?:text|copy|a |an )|rewrite|summari[sz]e|translate|open[- ]ended|ai[- ]generated|llm|classif(?:y|ication|ied|ier|ying)?|choose|decision|score|probability)\b/.test(lower));
  add("memory", /\b(memory|history|earlier conversation|previous conversation|remember|past interaction)\b/.test(lower));
  add("screenshot", /\b(screenshot|visual verification|verify (?:the )?layout|rendering)\b/.test(lower));
  add("escalate", /\b(escalat|wake (?:the )?agent|follow[- ]up agent|agent follow[- ]up|adapt the app|change the app itself)\b/.test(lower));
  add("store", /\b(persist|durable state|survive reload|remember state|application state)\b/.test(lower));
  return ids;
}
