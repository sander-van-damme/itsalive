import type { AppBridge } from "./bridge";
import { safeControlValue, safeKey, redactAttribute } from "./redaction";
import { serializeSemanticDocument } from "./semantic-document";
import type { BridgeMessage, ShellToAppPayload, InteractionSnapshot } from "../shared";

export const OBSERVED_EVENTS = ["click", "change", "input", "submit", "keydown", "pointerdown"] as const;
const RECENT_LIMIT = 12;
export const DEFAULT_HISTORY_RAW_LIMIT = 40;

export interface ObserverOptions { maxInFlight?: number; historyRawLimit?: number; maxHistoryCharacters?: number; /** Tests only: browser-dispatched jsdom events are never trusted. */ acceptUntrustedForTest?: boolean }

function semanticTarget(event: Event): { semantic: Element; actual: Element } | null {
  const path = event.composedPath();
  const actual = path.find(item => item instanceof Element) as Element | undefined;
  if (!actual || actual.closest("itsalive-history")) return null;
  const semantic = path.find(item => item instanceof Element && item.localName.includes("-") && item.localName !== "itsalive-interaction" && item.localName !== "itsalive-history") as Element | undefined;
  return { semantic: semantic ?? actual, actual };
}

function describe(element: Element): InteractionSnapshot["target"] {
  const state: Record<string, string | boolean> = {};
  for (const name of ["name", "role", "aria-label", "title", "data-state"]) if (element.hasAttribute(name)) state[name] = (redactAttribute(name, element.getAttribute(name)!) ?? "").slice(0, 200);
  if (element instanceof HTMLInputElement) state.checked = element.checked;
  const value = safeControlValue(element);
  return { tag: element.localName.slice(0, 100), ...(element.id ? { id: (redactAttribute("id", element.id) ?? "").slice(0, 200) } : {}), ...(value !== undefined ? { value } : {}), ...(Object.keys(state).length ? { state } : {}) };
}

function readRecord(node: Element): InteractionSnapshot {
  return { seq: Number(node.getAttribute("seq")), at: node.getAttribute("at") ?? "", type: node.getAttribute("type") ?? "", target: { tag: node.getAttribute("target") ?? "unknown", ...(node.getAttribute("target-id") ? { id: node.getAttribute("target-id")! } : {}) }, actualTarget: { tag: node.getAttribute("actual-target") ?? node.getAttribute("target") ?? "unknown", ...(node.hasAttribute("value") ? { value: node.getAttribute("value")! } : {}) } };
}

export function installInteractionObserver(bridge: AppBridge, options: ObserverOptions = {}) {
  let sequence = Math.max(0, ...Array.from(document.querySelectorAll("itsalive-interaction")).map(node => Number(node.getAttribute("seq")) || 0));
  let destroyed = false, inFlight = 0;
  let pending: { state: Parameters<typeof send>[0]; element: Element } | undefined;
  let compacting = false;
  const maxInFlight = Math.max(1, Math.min(options.maxInFlight ?? 2, 8));
  const rawLimit = Math.max(RECENT_LIMIT, options.historyRawLimit ?? DEFAULT_HISTORY_RAW_LIMIT);
  const maxHistoryCharacters = Math.max(8_000, options.maxHistoryCharacters ?? 32_000);

  const compact = async (history: Element) => {
    if (compacting) return;
    const records = [...history.querySelectorAll(":scope > itsalive-interaction")];
    const older = records.slice(0, Math.max(0, records.length - RECENT_LIMIT));
    if ((records.length < rawLimit && history.outerHTML.length < maxHistoryCharacters) || !older.length) return;
    compacting = true;
    try {
      const existing = history.querySelector(":scope > itsalive-history-summary")?.textContent ?? "";
      const prompt = `Compact these older interaction records into a concise, readable behavioral summary. Preserve meaningful patterns and outcomes, omit secrets, and return only the summary.\nExisting summary:\n${existing}\nRecords:\n${JSON.stringify(older.map(readRecord))}`;
      const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "llm.request", prompt }, 30_000);
      if (destroyed || response.type !== "llm.response" || response.error || typeof response.result !== "string" || !response.result.trim()) return;
      let summary = history.querySelector(":scope > itsalive-history-summary");
      if (!summary) { summary = document.createElement("itsalive-history-summary"); history.prepend(summary); }
      summary.textContent = response.result.slice(0, 8_000);
      older.forEach(node => node.remove());
    } catch (error) { console.warn("[itsalive:history] Compaction unavailable", error); }
    finally { compacting = false; }
  };

  async function send(state: { interaction: InteractionSnapshot; recentInteractions: InteractionSnapshot[]; historySummary?: string; document: string }, element: Element): Promise<void> {
    inFlight++;
    try {
      const response = await bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "jev.request", state }, 8_000);
      if (destroyed || response.type !== "jev.response" || response.error) return;
      element.setAttribute("jev", response.escalated ? "react" : "ignore"); element.setAttribute("probability", response.probability.toFixed(4));
    } catch (error) { console.warn("[itsalive:jev] Observation unavailable", error); }
    finally {
      inFlight--;
      const next = pending; pending = undefined;
      if (!destroyed && next) void send(next.state, next.element);
    }
  }

  const handler = (event: Event) => {
    if (!event.isTrusted && !options.acceptUntrustedForTest) return;
    try {
      const targets = semanticTarget(event); if (!targets) return;
      const history = document.querySelector("itsalive-history") ?? document.body.appendChild(Object.assign(document.createElement("itsalive-history"), { hidden: true }));
      const record: InteractionSnapshot = { seq: ++sequence, at: new Date().toISOString(), type: event.type.slice(0, 30), target: describe(targets.semantic), actualTarget: describe(targets.actual) };
      if (event instanceof KeyboardEvent) record.key = safeKey(event, targets.actual);
      const element = document.createElement("itsalive-interaction");
      for (const [name, value] of [["seq", String(record.seq)], ["at", record.at], ["type", record.type], ["target", record.target.tag], ["target-id", record.target.id], ["actual-target", record.actualTarget.tag]] as const) if (value) element.setAttribute(name, value);
      if (record.actualTarget.value !== undefined) element.setAttribute("value", record.actualTarget.value);
      history.append(element);
      const recentInteractions = [...history.querySelectorAll(":scope > itsalive-interaction")].slice(-RECENT_LIMIT).map(readRecord);
      const historySummary = history.querySelector(":scope > itsalive-history-summary")?.textContent?.slice(0, 8_000);
      const state = { interaction: record, recentInteractions, ...(historySummary ? { historySummary } : {}), document: serializeSemanticDocument() };
      if (inFlight < maxInFlight) void send(state, element); else pending = { state, element };
      void compact(history);
    } catch (error) { console.warn("[itsalive:observer] Interaction recording failed", error); }
  };
  for (const type of OBSERVED_EVENTS) document.addEventListener(type, handler, true);
  return { destroy() { destroyed = true; pending = undefined; for (const type of OBSERVED_EVENTS) document.removeEventListener(type, handler, true); } };
}
