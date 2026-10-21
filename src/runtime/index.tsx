import "./refresh-setup";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JSXRuntime from "react/jsx-runtime";
import * as JSXDevRuntime from "react/jsx-dev-runtime";
import * as Refresh from "react-refresh/runtime";
import * as Zustand from "zustand";
import * as ZustandVanilla from "zustand/vanilla";
import * as ZustandMiddleware from "zustand/middleware";
import { PortRPC, isRecord } from "../shared/bridge";
import type {
  BehaviorObservation,
  BuildArtifact,
  Json,
  RuntimeInit,
  RuntimeInspection,
} from "../shared/types";
import { ModuleGraph } from "./modules";
import {
  clearOriginStorage,
  exportOriginStorage,
  restoreOriginStorage,
} from "./origin-storage";

interface BoundaryProps {
  children: React.ReactNode;
  report: (error: Error) => void;
}
class Boundary extends React.Component<
  BoundaryProps,
  { error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override componentDidCatch(error: Error) {
    this.props.report(error);
  }
  override render() {
    return this.state.error ? (
      <div role="alert">
        This revision could not render. The previous revision is being restored.
      </div>
    ) : (
      this.props.children
    );
  }
}

function jsonState(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): value is Json {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid = Object.values(value).every((child) =>
    jsonState(child, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
}

function validArtifact(value: unknown): value is BuildArtifact {
  return (
    isRecord(value) &&
    typeof value.entry === "string" &&
    typeof value.revisionId === "string" &&
    typeof value.css === "string" &&
    isRecord(value.modules) &&
    Object.keys(value.modules).length < 5000 &&
    Object.values(value.modules).every(
      (module) =>
        isRecord(module) &&
        typeof module.code === "string" &&
        typeof module.hash === "string",
    )
  );
}

export function start(port: MessagePort, init: RuntimeInit): void {
  const errors: string[] = [];
  let revisionId: string | null = null;
  let applying = false;
  let applyingError: Error | null = null;
  let current: BuildArtifact | null = null;
  let graph: ModuleGraph | null = null;
  let root: ReactDOMClient.Root | null = null;
  let boundaryGeneration = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let storageOperation: AbortController | null = null;
  const state = ZustandVanilla.createStore<Record<string, Json>>(() =>
    structuredClone(init.state),
  );
  const mount = document.createElement("div");
  mount.id = "application";
  const styles = document.createElement("style");
  styles.dataset.itsalive = "generated";
  document.head.append(styles);
  document.body.replaceChildren(mount);
  document.documentElement.style.colorScheme = "light";
  document.body.style.margin = "0";

  const report = (error: unknown, kind = "runtime.error") => {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    errors.push(message);
    if (errors.length > 100) errors.shift();
    if (applying)
      applyingError = error instanceof Error ? error : new Error(message);
    rpc.event("diagnostic", {
      level: "INFO",
      event: kind,
      revisionId,
      message,
    });
  };
  const inspect = (): RuntimeInspection => ({
    text: mount.innerText.slice(0, 40_000),
    errors: [...errors],
    revisionId,
  });
  const requestAI = (
    method: string,
    prompt: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (init.mode !== "app")
      return Promise.reject(
        new Error("AI is disabled during candidate verification and backup"),
      );
    return rpc.request("ai", { method, prompt, ...extra }, 120_000);
  };
  const ai = {
    text: (prompt: string) => requestAI("text", prompt) as Promise<string>,
    decide: (prompt: string, context?: Json) =>
      requestAI("decide", prompt, { context }) as Promise<boolean>,
    choose: (prompt: string, options: string[], context?: Json) =>
      requestAI("choose", prompt, { options, context }) as Promise<string>,
    score: (
      prompt: string,
      levels = ["Low", "Medium", "High"],
      context?: Json,
    ) => requestAI("score", prompt, { levels, context }) as Promise<number>,
  };
  const storeAPI = {
    useStore: <T,>(selector: (state: Record<string, Json>) => T): T =>
      Zustand.useStore(state, selector),
    getState: state.getState,
    setState: (
      next:
        | Record<string, Json>
        | ((previous: Record<string, Json>) => Record<string, Json>),
    ) => {
      const value = typeof next === "function" ? next(state.getState()) : next;
      if (!isRecord(value) || !jsonState(value))
        throw new Error(
          "Durable state must contain JSON values without cycles",
        );
      state.setState(value);
    },
    store: {
      getState: state.getState,
      getInitialState: state.getInitialState,
      subscribe: state.subscribe,
      setState: (value: Record<string, Json>) => storeAPI.setState(value),
    },
  };
  const builtins: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": JSXRuntime,
    "react/jsx-dev-runtime": JSXDevRuntime,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    zustand: Zustand,
    "zustand/vanilla": ZustandVanilla,
    "zustand/middleware": ZustandMiddleware,
    "@itsalive/ai": ai,
    "@itsalive/store": storeAPI,
  };
  const refreshHooks = {
    register: (value: unknown, id: string) => Refresh.register(value, id),
    signature: () => Refresh.createSignatureFunctionForTransform(),
  };

  const render = (artifact: BuildArtifact) => {
    const entry = graph!.load(artifact.entry);
    if (typeof entry.default !== "function" && !isRecord(entry.default))
      throw new Error(
        "The project entry must export a default React component",
      );
    const App = entry.default as React.ComponentType;
    if (!root)
      root = ReactDOMClient.createRoot(mount, {
        onUncaughtError: (error) => report(error),
        onCaughtError: (error) => report(error),
      });
    ReactDOM.flushSync(() =>
      root!.render(
        <Boundary key={boundaryGeneration} report={report}>
          <App />
        </Boundary>,
      ),
    );
  };

  const apply = async (artifact: BuildArtifact) => {
    if (init.mode === "backup")
      throw new Error(
        "Backup mode cannot execute generated application source",
      );
    const begin = performance.now();
    const previous = current;
    const previousState = structuredClone(state.getState());
    const previousStyle = styles.textContent;
    let treeTouched = false;
    const changedModules = graph
      ? graph.update(artifact)
      : Object.keys(artifact.modules).length;
    if (!graph) graph = new ModuleGraph(artifact, builtins, refreshHooks);
    applying = true;
    applyingError = null;
    try {
      // Evaluate first. No style or React tree changes occur for top-level failures.
      graph.load(artifact.entry);
      styles.textContent = artifact.css;
      treeTouched = true;
      if (previous) Refresh.performReactRefresh();
      render(artifact);
      await new Promise<void>((resolve) => {
        // Background verification frames may have animation frames throttled.
        const timer = setTimeout(resolve, 150);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          }),
        );
      });
      if (applyingError) throw applyingError;
      current = artifact;
      revisionId = artifact.revisionId;
      rpc.event("state", state.getState());
      const durationMs = performance.now() - begin;
      rpc.event("applied", { revisionId, durationMs, changedModules });
      return { revisionId, durationMs, changedModules, inspection: inspect() };
    } catch (error) {
      state.setState(previousState, true);
      styles.textContent = previousStyle;
      if (previous) {
        graph = new ModuleGraph(previous, builtins, refreshHooks);
        graph.load(previous.entry);
        if (treeTouched) {
          Refresh.performReactRefresh();
          boundaryGeneration += 1;
          applyingError = null;
          render(previous);
        }
      } else {
        root?.unmount();
        root = null;
        graph = null;
      }
      report(error, "runtime.apply-failed");
      throw error;
    } finally {
      applying = false;
    }
  };

  const rpc = new PortRPC(port, async (method, payload) => {
    switch (method) {
      case "apply": {
        if (!validArtifact(payload))
          throw new Error("Invalid compiled artifact");
        const next = queue.catch(() => {}).then(() => apply(payload));
        queue = next;
        return next;
      }
      case "inspect":
        return inspect();
      case "snapshot":
        return structuredClone(state.getState());
      case "restore-state": {
        if (init.mode !== "app" || !isRecord(payload) || !jsonState(payload))
          throw new Error("Invalid durable-state restoration");
        state.setState(structuredClone(payload) as Record<string, Json>, true);
        return null;
      }
      case "backup": {
        if (init.mode !== "backup")
          throw new Error("Storage export requires a backup-only runtime");
        if (storageOperation)
          throw new Error("An origin-storage operation is already running");
        storageOperation = new AbortController();
        try {
          return await exportOriginStorage({ signal: storageOperation.signal });
        } finally {
          storageOperation = null;
        }
      }
      case "restore": {
        if (init.mode !== "backup")
          throw new Error("Storage restoration requires a backup-only runtime");
        if (storageOperation)
          throw new Error("An origin-storage operation is already running");
        storageOperation = new AbortController();
        try {
          return await restoreOriginStorage(
            payload as Parameters<typeof restoreOriginStorage>[0],
            { signal: storageOperation.signal },
          );
        } finally {
          storageOperation = null;
        }
      }
      case "cancel":
        storageOperation?.abort(new Error("Storage operation cancelled"));
        return null;
      case "cleanup": {
        if (init.mode !== "verify")
          throw new Error(
            "Cleanup is restricted to disposable verification origins",
          );
        return clearOriginStorage();
      }
      default:
        throw new Error(`Unknown runtime capability: ${method}`);
    }
  });
  state.subscribe((value) => {
    if (!applying && init.mode === "app") rpc.event("state", value);
  });
  window.addEventListener("error", (event) =>
    report(event.error ?? event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    report(event.reason, "runtime.rejection"),
  );
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    rpc.event("diagnostic", {
      level: "INFO",
      event: "console.error",
      revisionId,
      message: args
        .map((value) =>
          value instanceof Error
            ? value.message
            : typeof value === "string"
              ? value
              : "[object]",
        )
        .join(" ")
        .slice(0, 4000),
    });
  };

  if (init.mode !== "backup") {
    if (init.observe && init.mode === "app")
      observeBehavior((observation) => rpc.event("behavior", observation));
  }
  rpc.event("ready", { appId: init.appId, mode: init.mode });
}

function observeBehavior(
  send: (observation: BehaviorObservation) => void,
): void {
  let lastTarget: Element | null = null;
  let first = 0;
  let count = 0;
  let lastSuggestion = -60_000;
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest('button, a, [role="button"]')
          : null;
      if (!target) return;
      const now = performance.now();
      if (target === lastTarget && now - first < 4000) count += 1;
      else {
        lastTarget = target;
        first = now;
        count = 1;
      }
      if (count >= 4 && now - lastSuggestion > 60_000) {
        lastSuggestion = now;
        send({
          kind: "repeated-click",
          target: (
            target.getAttribute("aria-label") ??
            target.textContent ??
            target.tagName
          )
            .trim()
            .slice(0, 120),
          count,
          durationMs: now - first,
        });
      }
    },
    { passive: true },
  );
}
