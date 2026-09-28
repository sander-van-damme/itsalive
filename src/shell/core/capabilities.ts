export type PlatformCapabilityId = "done" | "verify" | "ai" | "escalate" | "memory" | "screenshot" | "store";

export interface PlatformApiDoc {
  name: string;
  capabilityId: PlatformCapabilityId;
  signature: string;
  purpose: string;
  parameters: string;
  returns: string;
  example: string;
  notes?: string;
}

/**
 * Canonical prompt/documentation metadata for the public generated-app and coding-agent APIs.
 *
 * Runtime TypeScript interfaces live in src/runtime/globals.d.ts. Keep this list aligned with
 * that public surface; tests assert every documented API is represented in the compact index.
 */
export const PLATFORM_APIS: readonly PlatformApiDoc[] = Object.freeze([
  {
    name: "application.store",
    capabilityId: "store",
    signature: "application.store: JsonObject",
    purpose: "Durable per-app state that survives document restore/reload.",
    parameters: "Assign only JsonValue values to properties under application.store.",
    returns: "A mutable JsonObject proxy persisted with the app document.",
    example: "application.store.counter ??= { count: 0 };",
    notes: "JsonValue allows null, boolean, finite number, string, arrays, and plain objects. undefined, functions, class instances, accessors, non-finite numbers, and circular references are rejected.",
  },
  {
    name: "application.ai.text",
    capabilityId: "ai",
    signature: "application.ai.text(prompt: string): Promise<string>",
    purpose: "Generate open-ended text through the shell-owned text model.",
    parameters: "prompt is the complete text-generation instruction.",
    returns: "Generated text as a string.",
    example: "await application.ai.text('Name this note') // -> 'Trip ideas'",
  },
  {
    name: "application.ai.choose",
    capabilityId: "ai",
    signature: "application.ai.choose<T extends string>(question: string, options: Record<T, string>, context?: JsonValue): Promise<T | null>",
    purpose: "Choose one key from a bounded option set.",
    parameters: "question states the decision; options maps stable keys to meanings; context is optional JSON-like evidence.",
    returns: "One option key, or null when the platform is not confident enough.",
    example: "await application.ai.choose('Route?', { billing: 'Payments', technical: 'Broken feature' }, ticket) // -> 'billing' | null",
    notes: "Handle null conservatively. Do not implement a second confidence threshold.",
  },
  {
    name: "application.ai.score",
    capabilityId: "ai",
    signature: "application.ai.score(question: string, levels: string[], context?: JsonValue): Promise<number | null>",
    purpose: "Place a case on an ordered scale.",
    parameters: "question states what to score; levels are ordered low-to-high labels; context is optional JSON-like evidence.",
    returns: "A numeric position on the scale, or null when the platform is not confident enough.",
    example: "await application.ai.score('Severity?', ['Low', 'Medium', 'High'], report) // -> 1.2 | null",
    notes: "Handle null conservatively. Do not implement a second confidence threshold.",
  },
  {
    name: "application.ai.decide",
    capabilityId: "ai",
    signature: "application.ai.decide(question: string, context?: JsonValue): Promise<boolean | null>",
    purpose: "Make a conservative yes/no decision.",
    parameters: "question should be answerable yes/no; context is optional JSON-like evidence.",
    returns: "true, false, or null when neither answer is confident enough.",
    example: "await application.ai.decide('Is this word English?', { word }) // -> true | false | null",
    notes: "Handle null explicitly. Do not implement a second confidence threshold.",
  },
  {
    name: "application.ai.probability",
    capabilityId: "ai",
    signature: "application.ai.probability(question: string, context?: JsonValue): Promise<number>",
    purpose: "Return a calibrated probability when the numeric probability itself is useful.",
    parameters: "question states the proposition; context is optional JSON-like evidence.",
    returns: "A number from 0 through 1.",
    example: "await application.ai.probability('Is this a refund request?', message) // -> 0.93",
  },
  {
    name: "application.escalate",
    capabilityId: "escalate",
    signature: "application.escalate(reason: string): void",
    purpose: "Ask the external coding agent to inspect or change the running app.",
    parameters: "reason explains the app-level problem that needs coding work.",
    returns: "Nothing; escalation is asynchronous and does not return the coding result to the current script.",
    example: "application.escalate('The imported schema changed. Inspect the app and adapt it.');",
  },
  {
    name: "agent.memory",
    capabilityId: "memory",
    signature: "agent.memory(): Promise<string>",
    purpose: "Read curated shell-owned memory relevant to the current app while coding.",
    parameters: "No parameters.",
    returns: "A compact text summary; never raw history records.",
    example: "const memory = await agent.memory();",
  },
  {
    name: "agent.screenshot",
    capabilityId: "screenshot",
    signature: "agent.screenshot(input?: { scale?: number }): Promise<string>",
    purpose: "Capture a best-effort screenshot for visual verification while coding.",
    parameters: "Optional scale controls screenshot resolution.",
    returns: "A screenshot data URL or a screenshot-unavailable marker string.",
    example: "const image = await agent.screenshot();",
    notes: "Screenshot unavailability alone is not a reason to fail the task; use DOM evidence instead.",
  },
  {
    name: "agent.verify",
    capabilityId: "verify",
    signature: "agent.verify<T>(work: () => T | Promise<T>): Promise<T>",
    purpose: "Run a coding-time verification transaction whose temporary DOM and application.store mutations are always rolled back.",
    parameters: "work is a synchronous or async verification callback. Prefer read-only checks; use this transaction when exercising behavior requires temporary mutations or events.",
    returns: "The callback result after restoring the exact pre-verification app document/store state. Callback errors are rethrown after rollback.",
    example: "const observed = await agent.verify(async () => { input.value = 'probe'; button.click(); return result.textContent; });",
    notes: "Verification transactions are coding-only. Do not use them for implementation changes because all mutations made inside work are intentionally discarded.",
  },
  {
    name: "agent.done",
    capabilityId: "done",
    signature: "agent.done(message?: string): unknown",
    purpose: "Signal that the current coding turn has completed its assigned task.",
    parameters: "message is optional text. Structured worker handoffs must be JSON.stringify(...) first.",
    returns: "An internal completion signal consumed by the runtime.",
    example: "return agent.done(JSON.stringify(handoff));",
  },
]);

export const PLATFORM_CAPABILITIES = Object.freeze([
  { id: "done", purpose: "Finish a coding task with the runtime completion signal." },
  { id: "verify", purpose: "Exercise behavior in a rollback-only coding verification transaction." },
  { id: "ai", purpose: "Generate text or make bounded AI decisions inside the running app." },
  { id: "escalate", purpose: "Escalate an app-level problem to the external coding agent." },
  { id: "memory", purpose: "Read curated coding context." },
  { id: "screenshot", purpose: "Capture a coding-time visual inspection." },
  { id: "store", purpose: "Persist JSON-like application state." },
] as const satisfies readonly { id: PlatformCapabilityId; purpose: string }[]);

const CAPABILITY_IDS = new Set<string>(PLATFORM_CAPABILITIES.map(capability => capability.id));

export function isPlatformCapabilityId(value: string): value is PlatformCapabilityId {
  return CAPABILITY_IDS.has(value);
}

export function platformApiIndex(): string {
  return [
    "type JsonValue = null | boolean | finite number | string | JsonValue[] | JsonObject;",
    "type JsonObject = { [key: string]: JsonValue };",
    ...PLATFORM_APIS.map(api => api.signature),
  ].join("\n");
}

export function platformCapabilityHelp(ids: readonly PlatformCapabilityId[]): string {
  const selected = new Set(ids);
  const apis = PLATFORM_APIS.filter(api => selected.has(api.capabilityId));
  if (!apis.length) return "(none selected)";
  return apis.map(api => [
    api.signature,
    `Purpose: ${api.purpose}`,
    `Parameters: ${api.parameters}`,
    `Returns: ${api.returns}`,
    `Example: ${api.example}`,
    ...(api.notes ? [`Notes: ${api.notes}`] : []),
  ].join("\n")).join("\n\n");
}

/**
 * Heuristic JIT-help selection only.
 *
 * This does not control API discovery: coding managers always receive platformApiIndex().
 */
export function inferPlatformCapabilities(text: string): PlatformCapabilityId[] {
  const lower = text.toLocaleLowerCase();
  const ids: PlatformCapabilityId[] = [];
  const add = (id: PlatformCapabilityId, matches: boolean) => { if (matches && !ids.includes(id)) ids.push(id); };

  add("ai", /\b(poem|story|haiku|lyrics?|generate(?:d)? (?:text|copy|content|an? answer)|write (?:text|copy|a |an )|rewrite|summari[sz]e|translate|open[- ]ended|ai[- ]generated|llm|classif(?:y|ication|ied|ier|ying)?|choose|chooses|chosen|decid(?:e|es|ed|ing)|decision|score|scores|scoring|probabilit(?:y|ies))\b/.test(lower));
  add("memory", /\b(memory|history|earlier conversation|previous conversation|remember|past interaction)\b/.test(lower));
  add("screenshot", /\b(screenshot|visual verification|verify (?:the )?layout|rendering)\b/.test(lower));
  add("escalate", /\b(escalat|wake (?:the )?agent|follow[- ]up agent|agent follow[- ]up|adapt the app|change the app itself)\b/.test(lower));
  add("store", /\b(persist|durable state|survive reload|remember state|application state)\b/.test(lower));
  return ids;
}
