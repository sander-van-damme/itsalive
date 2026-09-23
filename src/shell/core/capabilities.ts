export const PLATFORM_CAPABILITIES = [
  {
    id: "done",
    signature: "return itsalive.done(message)",
    purpose: "Signal that the current coding task is actually complete and optionally provide a short user-facing completion message.",
    whenToUse: "Use only from the final coding command after the requested outcome works and verification is complete.",
    whenNotToUse: "Do not use while staged UI is unfinished or while a repair/verification step remains.",
    example: "return itsalive.done('Ready to use.');",
  },
  {
    id: "llm.ask",
    signature: "await itsalive.llm.ask(prompt)",
    purpose: "Ask the configured LLM for open-ended generated or transformed content at app runtime.",
    whenToUse: "Use when the app itself must generate, rewrite, summarize, translate, classify, or answer with content that should not be pre-baked locally.",
    whenNotToUse: "Do not use for deterministic calculations, fixed copy, or behavior the browser can implement directly.",
    example: "const poem = await itsalive.llm.ask('Write a short poem about the sea.');",
  },
  {
    id: "history.search",
    signature: "await itsalive.history.search({ query, limit? })",
    purpose: "Search shell-owned app history with literal text retrieval.",
    whenToUse: "Use when runtime behavior genuinely needs earlier app conversation or events and a focused literal query is known.",
    whenNotToUse: "Do not use as a substitute for current DOM state or to load the entire chat transcript.",
    example: "const matches = await itsalive.history.search({ query: 'preferred tempo', limit: 5 });",
  },
  {
    id: "logs.get",
    signature: "await itsalive.logs.get({ level?, limit? })",
    purpose: "Read bounded shell-owned runtime logs for diagnosis.",
    whenToUse: "Use when a runtime failure needs recent error or warning evidence.",
    whenNotToUse: "Do not poll logs for ordinary state or user-facing data.",
    example: "const errors = await itsalive.logs.get({ level: 'error', limit: 20 });",
  },
  {
    id: "dom.screenshot",
    signature: "await itsalive.dom.screenshot({ scale? })",
    purpose: "Capture a best-effort screenshot for visual verification.",
    whenToUse: "Use when visual layout or rendering needs verification beyond DOM inspection.",
    whenNotToUse: "Do not block completion solely because screenshot capture is unavailable.",
    example: "const image = await itsalive.dom.screenshot();",
  },
  {
    id: "components",
    signature: "itsalive.components[key]",
    purpose: "Read a platform-provided catalog of editable Alpine/Tailwind component recipes.",
    whenToUse: "Use when a known UI pattern such as a modal, picker, menu, or alternate example would save implementation work.",
    whenNotToUse: "Do not insert recipes blindly or treat the catalog as a runtime widget framework.",
    example: "const modalRecipe = itsalive.components['modal'];",
  },
  {
    id: "cron",
    signature: "itsalive.cron(id, schedule, callback)",
    purpose: "Register a stable scheduled callback through the shell.",
    whenToUse: "Use when the app has an explicit recurring or scheduled behavior.",
    whenNotToUse: "Do not use for short timers, animation, or immediate interaction handling.",
    example: "itsalive.cron('daily-review', '0 8 * * *', () => refreshDailyReview());",
  },
  {
    id: "agent.wake",
    signature: "await itsalive.agent.wake(prompt)",
    purpose: "Ask the shell to start another agent run for follow-up work.",
    whenToUse: "Use sparingly when app runtime evidence shows that another coding/agent turn is genuinely needed.",
    whenNotToUse: "Do not use for ordinary UI actions or as a general event bus.",
    example: "await itsalive.agent.wake('The imported data schema changed; adapt the parser.');",
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

  add("llm.ask", /\b(poem|story|haiku|lyrics?|generate (?:text|copy|content|an? answer)|write (?:text|copy|a |an )|rewrite|summari[sz]e|translate|open[- ]ended|ai[- ]generated|llm)\b/.test(lower));
  add("history.search", /\b(history|earlier conversation|previous conversation|remember|past interaction)\b/.test(lower));
  add("logs.get", /\b(logs?|runtime error|debug|diagnos|stack trace)\b/.test(lower));
  add("dom.screenshot", /\b(screenshot|visual verification|verify (?:the )?layout|rendering)\b/.test(lower));
  add("components", /\b(modal|dialog|date picker|dropdown|menu|popover|component recipe)\b/.test(lower));
  add("cron", /\b(cron|schedule|scheduled|every day|daily|weekly|recurring)\b/.test(lower));
  add("agent.wake", /\b(wake (?:the )?agent|follow[- ]up agent|agent follow[- ]up)\b/.test(lower));
  return ids;
}
