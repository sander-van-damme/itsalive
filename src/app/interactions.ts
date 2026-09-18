import type { AppBridge } from "./bridge";
import { safeControlValue, safeKey, redactAttribute } from "./redaction";
import { serializeSemanticDocument } from "./semantic-document";
import type { BridgeMessage, ShellToAppPayload, InteractionPattern, InteractionSnapshot, JevState } from "../shared";

export const OBSERVED_EVENTS = ["click", "change", "input", "submit", "keydown"] as const;
const RECENT_LIMIT = 12;
const MAX_REWRITE_QUEUE = 40;
const DEFAULT_REPEAT_WINDOW_MS = 1_500;
const DEFAULT_REPEAT_IDLE_MS = 250;
const RAPID_REPEAT_AVERAGE_MS = 450;
const FRUSTRATION_ACTION_COUNT = 5;
export const DEFAULT_HISTORY_REWRITE_INTERVAL = 12;

export interface ObserverOptions {
  maxInFlight?: number;
  historyRewriteInterval?: number;
  repeatWindowMs?: number;
  repeatIdleMs?: number;
  /** Tests only: browser-dispatched jsdom events are never trusted. */
  acceptUntrustedForTest?: boolean;
}

interface BehavioralSample {
  interaction: InteractionSnapshot;
  pattern?: InteractionPattern;
}

interface LastAction {
  key: string;
  at: number;
  document: string;
}

interface RepeatAggregate {
  key: string;
  firstAt: number;
  lastAt: number;
  actionCount: number;
  documentChangeCount: number;
  lastDocument: string;
  record: InteractionSnapshot;
  likelyBenignControl: boolean;
  timer?: number;
}

function semanticTarget(event: Event): { semantic: Element; actual: Element } | null {
  const path = event.composedPath();
  const actual = path.find(item => item instanceof Element) as Element | undefined;
  if (!actual || actual.closest("itsalive-history")) return null;
  const semantic = path.find(item => item instanceof Element && (
    item.matches("[data-component], [data-app], main, section, article, form, nav, dialog")
    || item.localName.includes("-")
  ) && item.localName !== "itsalive-history") as Element | undefined;
  return { semantic: semantic ?? actual, actual };
}

function describe(element: Element): InteractionSnapshot["target"] {
  const state: Record<string, string | boolean> = {};
  for (const name of ["name", "role", "aria-label", "title", "data-state"]) {
    if (element.hasAttribute(name)) state[name] = (redactAttribute(name, element.getAttribute(name)!) ?? "").slice(0, 200);
  }
  if (element instanceof HTMLInputElement) state.checked = element.checked;
  const value = safeControlValue(element);
  return {
    tag: element.localName.slice(0, 100),
    ...(element.id ? { id: (redactAttribute("id", element.id) ?? "").slice(0, 200) } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(Object.keys(state).length ? { state } : {}),
  };
}

function likelyBenignRepeat(element: Element): boolean {
  if (element.matches("audio, video, input[type=range], [data-itsalive-repeatable], [data-repeatable]")) return true;
  const hint = [
    element.id,
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement ? element.textContent : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(?:play|pause|hear|listen|sound|audio|tone|note|chord|piano|drum|beat|preview|sample)\b/.test(hint);
}

function prepareCuratedHistory(ownerDocument: Document): { history: Element; summary: Element } {
  const histories = [...ownerDocument.querySelectorAll("itsalive-history")];
  const history = histories.shift() ?? ownerDocument.body.appendChild(ownerDocument.createElement("itsalive-history"));
  histories.forEach(node => node.remove());
  history.setAttribute("hidden", "");

  const summaries = [...history.querySelectorAll(":scope > itsalive-history-summary")];
  const summary = summaries.shift() ?? history.appendChild(ownerDocument.createElement("itsalive-history-summary"));
  summaries.forEach(node => node.remove());

  // Migration from older runtimes: raw telemetry must never survive in persisted HTML.
  history.querySelectorAll(":scope > :not(itsalive-history-summary)").forEach(node => node.remove());
  ownerDocument.querySelectorAll("itsalive-interaction, itsalive-target, itsalive-actual-target").forEach(node => node.remove());
  return { history, summary };
}

export function installInteractionObserver(bridge: AppBridge, options: ObserverOptions = {}) {
  const ownerDocument = document;
  const { history, summary } = prepareCuratedHistory(ownerDocument);
  let sequence = 0;
  let destroyed = false;
  let inFlight = 0;
  let rewriting = false;
  let preserving = false;
  let pending: Parameters<typeof send>[0] | undefined;
  let lastAction: LastAction | undefined;
  let repeatAggregate: RepeatAggregate | undefined;
  let elementSequence = 0;
  const elementIds = new WeakMap<Element, number>();
  const recentInteractions: InteractionSnapshot[] = [];
  let rewriteQueue: BehavioralSample[] = [];
  const maxInFlight = Math.max(1, Math.min(options.maxInFlight ?? 2, 8));
  const rewriteInterval = Math.max(2, Math.min(options.historyRewriteInterval ?? DEFAULT_HISTORY_REWRITE_INTERVAL, MAX_REWRITE_QUEUE));
  const repeatWindowMs = Math.max(0, Math.min(options.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS, 10_000));
  const repeatIdleMs = Math.max(10, Math.min(options.repeatIdleMs ?? DEFAULT_REPEAT_IDLE_MS, repeatWindowMs || DEFAULT_REPEAT_IDLE_MS));

  const preserveHistory = () => {
    if (destroyed || preserving) return;
    preserving = true;
    try {
      ownerDocument.querySelectorAll("itsalive-history").forEach(node => { if (node !== history) node.remove(); });
      if (!history.isConnected && ownerDocument.body) ownerDocument.body.append(history);
      history.setAttribute("hidden", "");
      history.querySelectorAll(":scope > :not(itsalive-history-summary)").forEach(node => node.remove());
      if (!summary.isConnected) history.append(summary);
    } catch (error) {
      console.warn("[itsalive:history] Preservation unavailable", error);
    } finally {
      preserving = false;
    }
  };
  const historyObserver = new MutationObserver(preserveHistory);
  historyObserver.observe(ownerDocument.documentElement, { childList: true, subtree: true });

  const rewriteHistory = async () => {
    if (destroyed || rewriting || rewriteQueue.length < rewriteInterval) return;
    rewriting = true;
    let rewritten = false;
    const batch = rewriteQueue.splice(0);
    try {
      const existing = summary.textContent?.trim() ?? "";
      const prompt = `Rewrite the behavioral history as one concise curated summary. Preserve durable preferences, recurring patterns, meaningful outcomes, and unresolved needs. Omit secrets and implementation noise. Do not reproduce event records or timestamps verbatim. Return only the rewritten summary.\n\nExisting curated history:\n${existing || "(none)"}\n\nNew ephemeral interactions:\n${JSON.stringify(batch)}`;
      const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "llm.request", prompt }, 30_000);
      if (destroyed || response.type !== "llm.response" || response.error || typeof response.result !== "string" || !response.result.trim()) {
        rewriteQueue = [...batch, ...rewriteQueue].slice(-MAX_REWRITE_QUEUE);
        return;
      }
      summary.textContent = response.result.trim().slice(0, 8_000);
      rewritten = true;
    } catch (error) {
      rewriteQueue = [...batch, ...rewriteQueue].slice(-MAX_REWRITE_QUEUE);
      console.warn("[itsalive:history] Rewrite unavailable", error);
    } finally {
      rewriting = false;
      if (rewritten && !destroyed && rewriteQueue.length >= rewriteInterval) void rewriteHistory();
    }
  };

  async function send(state: JevState): Promise<void> {
    inFlight++;
    try {
      await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "jev.request", state }, 8_000);
    } catch (error) {
      console.warn("[itsalive:jev] Observation unavailable", error);
    } finally {
      inFlight--;
      const next = pending;
      pending = undefined;
      if (!destroyed && next) void send(next);
    }
  }

  const dispatchObservation = (record: InteractionSnapshot, semanticDocument: string, pattern?: InteractionPattern) => {
    recentInteractions.push(record);
    if (recentInteractions.length > RECENT_LIMIT) recentInteractions.shift();
    rewriteQueue.push({ interaction: record, ...(pattern ? { pattern } : {}) });
    if (rewriteQueue.length > MAX_REWRITE_QUEUE) rewriteQueue = rewriteQueue.slice(-MAX_REWRITE_QUEUE);

    const historySummary = summary.textContent?.trim().slice(0, 8_000);
    const state: JevState = {
      interaction: record,
      recentInteractions: [...recentInteractions],
      ...(pattern ? { pattern } : {}),
      ...(historySummary ? { historySummary } : {}),
      document: semanticDocument,
    };
    if (inFlight < maxInFlight) void send(state);
    else pending = state;
    if (pattern) console.info("[itsalive:observer] Coalesced interaction burst", {
      actionCount: pattern.actionCount,
      coalescedCount: pattern.coalescedCount,
      likelyBenign: pattern.likelyBenign,
      frustrationSignal: pattern.frustrationSignal,
    });
    void rewriteHistory();
  };

  const flushRepeat = () => {
    const aggregate = repeatAggregate;
    repeatAggregate = undefined;
    if (!aggregate || destroyed) return;
    if (aggregate.timer !== undefined) window.clearTimeout(aggregate.timer);
    const durationMs = Math.min(60_000, Math.max(0, aggregate.lastAt - aggregate.firstAt));
    const averageIntervalMs = aggregate.actionCount > 1 ? durationMs / (aggregate.actionCount - 1) : 0;
    const likelyBenign = aggregate.likelyBenignControl || aggregate.documentChangeCount > 0;
    const pattern: InteractionPattern = {
      kind: "repeated-action",
      actionCount: Math.min(1_000, aggregate.actionCount),
      coalescedCount: Math.min(998, Math.max(0, aggregate.actionCount - 2)),
      durationMs,
      averageIntervalMs: Math.min(60_000, averageIntervalMs),
      documentChangeCount: Math.min(999, aggregate.documentChangeCount),
      likelyBenign,
      frustrationSignal: aggregate.actionCount >= FRUSTRATION_ACTION_COUNT
        && averageIntervalMs <= RAPID_REPEAT_AVERAGE_MS
        && aggregate.documentChangeCount === 0
        && !likelyBenign,
    };
    dispatchObservation(aggregate.record, aggregate.lastDocument, pattern);
  };

  const scheduleRepeatFlush = () => {
    if (!repeatAggregate) return;
    if (repeatAggregate.timer !== undefined) window.clearTimeout(repeatAggregate.timer);
    repeatAggregate.timer = window.setTimeout(flushRepeat, repeatIdleMs);
  };

  const identity = (element: Element) => {
    let id = elementIds.get(element);
    if (!id) { id = ++elementSequence; elementIds.set(element, id); }
    return id;
  };

  const observe = (type: string, semantic: Element, actual: Element, key?: string) => {
    if (destroyed) return;
    const now = Date.now();
    const semanticDocument = serializeSemanticDocument();
    const record: InteractionSnapshot = {
      seq: ++sequence,
      at: new Date(now).toISOString(),
      type: type.slice(0, 30),
      target: describe(semantic),
      actualTarget: describe(actual),
      ...(key ? { key } : {}),
    };
    const actionKey = `${type}:${identity(actual)}:${key ?? ""}`;
    const withinRepeatWindow = Boolean(lastAction && lastAction.key === actionKey && now - lastAction.at <= repeatWindowMs);

    if (withinRepeatWindow && lastAction) {
      if (!repeatAggregate || repeatAggregate.key !== actionKey) {
        if (repeatAggregate) flushRepeat();
        repeatAggregate = {
          key: actionKey,
          firstAt: lastAction.at,
          lastAt: now,
          actionCount: 2,
          documentChangeCount: semanticDocument === lastAction.document ? 0 : 1,
          lastDocument: semanticDocument,
          record,
          likelyBenignControl: likelyBenignRepeat(actual),
        };
      } else {
        repeatAggregate.lastAt = now;
        repeatAggregate.actionCount++;
        if (semanticDocument !== repeatAggregate.lastDocument) repeatAggregate.documentChangeCount++;
        repeatAggregate.lastDocument = semanticDocument;
        repeatAggregate.record = record;
        repeatAggregate.likelyBenignControl ||= likelyBenignRepeat(actual);
      }
      lastAction = { key: actionKey, at: now, document: semanticDocument };
      scheduleRepeatFlush();
      return;
    }

    if (repeatAggregate) flushRepeat();
    lastAction = { key: actionKey, at: now, document: semanticDocument };
    dispatchObservation(record, semanticDocument);
  };

  const handler = (event: Event) => {
    if (!event.isTrusted && !options.acceptUntrustedForTest) return;
    try {
      const targets = semanticTarget(event);
      if (!targets) return;
      const type = event.type;
      const key = event instanceof KeyboardEvent ? safeKey(event, targets.actual) : undefined;
      queueMicrotask(() => observe(type, targets.semantic, targets.actual, key));
    } catch (error) {
      console.warn("[itsalive:observer] Interaction observation failed", error);
    }
  };

  for (const type of OBSERVED_EVENTS) ownerDocument.addEventListener(type, handler, true);
  return {
    destroy() {
      destroyed = true;
      pending = undefined;
      recentInteractions.splice(0);
      rewriteQueue = [];
      if (repeatAggregate?.timer !== undefined) window.clearTimeout(repeatAggregate.timer);
      repeatAggregate = undefined;
      lastAction = undefined;
      historyObserver.disconnect();
      for (const type of OBSERVED_EVENTS) ownerDocument.removeEventListener(type, handler, true);
    },
  };
}
