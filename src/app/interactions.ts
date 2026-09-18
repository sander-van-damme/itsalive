import type { AppBridge } from "./bridge";
import { safeControlValue, safeKey, redactAttribute } from "./redaction";
import { serializeSemanticDocument } from "./semantic-document";
import type { BridgeMessage, ShellToAppPayload, InteractionSnapshot } from "../shared";

export const OBSERVED_EVENTS = ["click", "change", "input", "submit", "keydown", "pointerdown"] as const;
const RECENT_LIMIT = 12;
const MAX_REWRITE_QUEUE = 40;
export const DEFAULT_HISTORY_REWRITE_INTERVAL = 12;

export interface ObserverOptions {
  maxInFlight?: number;
  historyRewriteInterval?: number;
  /** Tests only: browser-dispatched jsdom events are never trusted. */
  acceptUntrustedForTest?: boolean;
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
  const recentInteractions: InteractionSnapshot[] = [];
  let rewriteQueue: InteractionSnapshot[] = [];
  const maxInFlight = Math.max(1, Math.min(options.maxInFlight ?? 2, 8));
  const rewriteInterval = Math.max(2, Math.min(options.historyRewriteInterval ?? DEFAULT_HISTORY_REWRITE_INTERVAL, MAX_REWRITE_QUEUE));

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

  async function send(state: { interaction: InteractionSnapshot; recentInteractions: InteractionSnapshot[]; historySummary?: string; document: string }): Promise<void> {
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

  const handler = (event: Event) => {
    if (!event.isTrusted && !options.acceptUntrustedForTest) return;
    try {
      const targets = semanticTarget(event);
      if (!targets) return;
      const record: InteractionSnapshot = {
        seq: ++sequence,
        at: new Date().toISOString(),
        type: event.type.slice(0, 30),
        target: describe(targets.semantic),
        actualTarget: describe(targets.actual),
      };
      if (event instanceof KeyboardEvent) record.key = safeKey(event, targets.actual);

      recentInteractions.push(record);
      if (recentInteractions.length > RECENT_LIMIT) recentInteractions.shift();
      rewriteQueue.push(record);
      if (rewriteQueue.length > MAX_REWRITE_QUEUE) rewriteQueue = rewriteQueue.slice(-MAX_REWRITE_QUEUE);

      const historySummary = summary.textContent?.trim().slice(0, 8_000);
      const state = {
        interaction: record,
        recentInteractions: [...recentInteractions],
        ...(historySummary ? { historySummary } : {}),
        document: serializeSemanticDocument(),
      };
      if (inFlight < maxInFlight) void send(state);
      else pending = state;
      void rewriteHistory();
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
      historyObserver.disconnect();
      for (const type of OBSERVED_EVENTS) ownerDocument.removeEventListener(type, handler, true);
    },
  };
}
