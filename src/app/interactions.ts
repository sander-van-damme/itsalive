import type { AppBridge } from "./bridge";
import { serializeSemanticDocument } from "./semantic-document";
import type { BridgeMessage, ShellToAppPayload, InteractionSnapshot } from "../shared";

export const OBSERVED_EVENTS = ["click", "change", "input", "submit", "keydown", "pointerdown"] as const;
const RECENT_LIMIT = 12;

function semanticTarget(event: Event): { semantic: Element; actual: Element } | null {
  const path = event.composedPath();
  const actual = path.find(item => item instanceof Element) as Element | undefined;
  if (!actual || actual.closest("itsalive-history")) return null;
  const semantic = path.find(item => item instanceof Element && item.localName.includes("-") && item.localName !== "itsalive-interaction" && item.localName !== "itsalive-history") as Element | undefined;
  return { semantic: semantic ?? actual, actual };
}

function safeValue(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    if (element.type === "password" || element.type === "file" || /(?:secret|token|credential|api[-_]?key)/i.test(element.name)) return undefined;
    return element.value.slice(0, 500);
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value.slice(0, 500);
  return undefined;
}

function describe(element: Element): { tag: string; id?: string; value?: string; state?: Record<string, string | boolean> } {
  const state: Record<string, string | boolean> = {};
  for (const name of ["name", "role", "aria-label", "title", "data-state"]) if (element.hasAttribute(name)) state[name] = element.getAttribute(name)!.slice(0, 200);
  if (element instanceof HTMLInputElement) state.checked = element.checked;
  return { tag: element.localName, ...(element.id ? { id: element.id } : {}), ...(safeValue(element) !== undefined ? { value: safeValue(element) } : {}), ...(Object.keys(state).length ? { state } : {}) };
}

export function installInteractionObserver(bridge: AppBridge) {
  let sequence = Math.max(0, ...Array.from(document.querySelectorAll("itsalive-interaction")).map(node => Number(node.getAttribute("seq")) || 0));
  let destroyed = false;
  const handler = (event: Event) => {
    if (!event.isTrusted && event.type !== "click") return;
    const targets = semanticTarget(event); if (!targets) return;
    const history = document.querySelector("itsalive-history") ?? document.body.appendChild(Object.assign(document.createElement("itsalive-history"), { hidden: true }));
    const record: InteractionSnapshot = { seq: ++sequence, at: new Date().toISOString(), type: event.type, target: describe(targets.semantic), actualTarget: describe(targets.actual) };
    if (event instanceof KeyboardEvent) record.key = event.key.length === 1 ? event.key : event.key.slice(0, 30);
    const element = document.createElement("itsalive-interaction");
    const attributes: Array<[string, string | undefined]> = [["seq", String(record.seq)], ["at", record.at], ["type", record.type], ["target", record.target.tag], ["target-id", record.target.id]];
    for (const [name, value] of attributes) if (value) element.setAttribute(name, value);
    if (record.actualTarget.value !== undefined) element.setAttribute("value", record.actualTarget.value);
    history.append(element);
    const recentInteractions = Array.from(history.querySelectorAll("itsalive-interaction")).slice(-RECENT_LIMIT).map(node => ({ seq: Number(node.getAttribute("seq")), at: node.getAttribute("at") ?? "", type: node.getAttribute("type") ?? "", target: { tag: node.getAttribute("target") ?? "unknown", ...(node.getAttribute("target-id") ? { id: node.getAttribute("target-id")! } : {}) }, actualTarget: { tag: node.getAttribute("target") ?? "unknown", ...(node.hasAttribute("value") ? { value: node.getAttribute("value")! } : {}) } }));
    const state = { interaction: record, recentInteractions, document: serializeSemanticDocument() };
    console.debug("[itsalive:observer] Interaction observed", { seq: record.seq, type: record.type, target: record.target.tag, snapshotCharacters: state.document.length });
    void bridge.request<BridgeMessage<ShellToAppPayload>>({ type: "jev.request", state }, 8_000).then(response => {
      if (destroyed || response.type !== "jev.response") return;
      if (response.error) throw new Error(response.error.message);
      element.setAttribute("jev", response.escalated ? "react" : "ignore");
      element.setAttribute("probability", response.probability.toFixed(4));
    }).catch(error => console.warn("[itsalive:jev] Observation unavailable", error));
  };
  for (const type of OBSERVED_EVENTS) document.addEventListener(type, handler, true);
  return { destroy() { destroyed = true; for (const type of OBSERVED_EVENTS) document.removeEventListener(type, handler, true); } };
}
