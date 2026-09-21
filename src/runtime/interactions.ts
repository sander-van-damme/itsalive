import type { AppBridge } from "./bridge";
import { safeControlValue, safeKey, redactAttribute } from "./redaction";
import { serializeSemanticDocument } from "./semantic-document";
import type { BridgeMessage, InteractionObservation, InteractionPatternSample, InteractionSnapshot, ShellToAppPayload } from "../shared";

export const OBSERVED_EVENTS = ["click", "change", "input", "submit", "keydown"] as const;
const DEFAULT_REPEAT_WINDOW_MS = 1_500;
const DEFAULT_REPEAT_IDLE_MS = 250;

export interface ObserverOptions {
  maxInFlight?: number;
  repeatWindowMs?: number;
  repeatIdleMs?: number;
  /** Tests only: browser-dispatched jsdom events are never trusted. */
  acceptUntrustedForTest?: boolean;
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
  timer?: number;
}

function semanticTarget(event: Event): { semantic: Element; actual: Element } | null {
  const path = event.composedPath();
  const actual = path.find(item => item instanceof Element) as Element | undefined;
  if (!actual) return null;
  const semantic = path.find(item => item instanceof Element && (
    item.matches("[data-component], [data-app], main, section, article, form, nav, dialog")
    || item.localName.includes("-")
  )) as Element | undefined;
  return { semantic: semantic ?? actual, actual };
}

function describe(element: Element): InteractionSnapshot["target"] {
  const state: Record<string, string | boolean> = {};
  for (const name of ["name", "type", "role", "aria-label", "title", "data-state", "data-itsalive-repeatable", "data-repeatable"]) {
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

export function installInteractionObserver(bridge: AppBridge, options: ObserverOptions = {}) {
  let sequence = 0;
  let destroyed = false;
  let inFlight = 0;
  let pending: InteractionObservation | undefined;
  let lastAction: LastAction | undefined;
  let repeatAggregate: RepeatAggregate | undefined;
  let elementSequence = 0;
  const elementIds = new WeakMap<Element, number>();
  const maxInFlight = Math.max(1, Math.min(options.maxInFlight ?? 2, 8));
  const repeatWindowMs = Math.max(0, Math.min(options.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS, 10_000));
  const repeatIdleMs = Math.max(10, Math.min(options.repeatIdleMs ?? DEFAULT_REPEAT_IDLE_MS, repeatWindowMs || DEFAULT_REPEAT_IDLE_MS));

  async function send(state: InteractionObservation): Promise<void> {
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

  const dispatchObservation = (record: InteractionSnapshot, semanticDocument: string, pattern?: InteractionPatternSample) => {
    const state: InteractionObservation = {
      interaction: record,
      ...(pattern ? { pattern } : {}),
      document: semanticDocument,
    };
    if (inFlight < maxInFlight) void send(state);
    else pending = state;
    if (pattern) console.info("[itsalive:observer] Coalesced interaction burst", {
      actionCount: pattern.actionCount,
      coalescedCount: pattern.coalescedCount,
      documentChangeCount: pattern.documentChangeCount,
    });
  };

  const flushRepeat = () => {
    const aggregate = repeatAggregate;
    repeatAggregate = undefined;
    if (!aggregate || destroyed) return;
    if (aggregate.timer !== undefined) window.clearTimeout(aggregate.timer);
    const durationMs = Math.min(60_000, Math.max(0, aggregate.lastAt - aggregate.firstAt));
    const averageIntervalMs = aggregate.actionCount > 1 ? durationMs / (aggregate.actionCount - 1) : 0;
    const pattern: InteractionPatternSample = {
      kind: "repeated-action",
      actionCount: Math.min(1_000, aggregate.actionCount),
      coalescedCount: Math.min(998, Math.max(0, aggregate.actionCount - 2)),
      durationMs,
      averageIntervalMs: Math.min(60_000, averageIntervalMs),
      documentChangeCount: Math.min(999, aggregate.documentChangeCount),
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
    if (!id) {
      id = ++elementSequence;
      elementIds.set(element, id);
    }
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
        };
      } else {
        repeatAggregate.lastAt = now;
        repeatAggregate.actionCount++;
        if (semanticDocument !== repeatAggregate.lastDocument) repeatAggregate.documentChangeCount++;
        repeatAggregate.lastDocument = semanticDocument;
        repeatAggregate.record = record;
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
      const key = event instanceof KeyboardEvent ? safeKey(event, targets.actual) : undefined;
      queueMicrotask(() => observe(event.type, targets.semantic, targets.actual, key));
    } catch (error) {
      console.warn("[itsalive:observer] Interaction observation failed", error);
    }
  };

  for (const type of OBSERVED_EVENTS) document.addEventListener(type, handler, true);
  return {
    destroy() {
      destroyed = true;
      pending = undefined;
      if (repeatAggregate?.timer !== undefined) window.clearTimeout(repeatAggregate.timer);
      repeatAggregate = undefined;
      lastAction = undefined;
      for (const type of OBSERVED_EVENTS) document.removeEventListener(type, handler, true);
    },
  };
}
