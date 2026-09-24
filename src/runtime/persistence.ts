import type { AppDocumentSnapshot, AppScriptSnapshot } from "../shared";

const RUNTIME_SELECTOR = "[data-app-runtime]";

type AlpineRuntime = {
  stopObservingMutations?: () => void;
  startObservingMutations?: () => void;
  initTree?: (root: Element) => void;
};

function normalizeControls(root: ParentNode) {
  root.querySelectorAll<HTMLInputElement>("input").forEach(input => {
    if (input.type === "checkbox" || input.type === "radio") input.toggleAttribute("checked", input.checked);
    else if (input.type !== "file") input.setAttribute("value", input.value);
  });
  root.querySelectorAll<HTMLTextAreaElement>("textarea").forEach(textarea => { textarea.textContent = textarea.value; });
  root.querySelectorAll<HTMLSelectElement>("select").forEach(select => {
    Array.from(select.options).forEach(option => option.toggleAttribute("selected", option.selected));
  });
  root.querySelectorAll<HTMLDetailsElement>("details").forEach(details => details.toggleAttribute("open", details.open));
}

function snapshotScript(script: HTMLScriptElement): AppScriptSnapshot {
  return {
    placement: script.closest("head") ? "head" : "body",
    attributes: Object.fromEntries(Array.from(script.attributes, attribute => [attribute.name, attribute.value])),
    content: script.textContent ?? "",
  };
}

export function serializeAppDocument(store = "{}"): AppDocumentSnapshot {
  normalizeControls(document);
  const html = document.documentElement.cloneNode(true) as HTMLElement;
  html.querySelectorAll(RUNTIME_SELECTOR).forEach(node => node.remove());
  const scripts = Array.from(html.querySelectorAll<HTMLScriptElement>("script")).map(snapshotScript);
  html.querySelectorAll("script").forEach(script => script.remove());
  return { html: `<!doctype html>\n${html.outerHTML}`, scripts, store };
}

async function executeScripts(scripts: readonly AppScriptSnapshot[]): Promise<void> {
  for (const saved of scripts) {
    const script = document.createElement("script");
    for (const [name, value] of Object.entries(saved.attributes)) script.setAttribute(name, value);
    script.textContent = saved.content;
    const waitsForLoad = Boolean(script.src) || script.type === "module";
    const loaded = waitsForLoad ? new Promise<void>((resolve, reject) => {
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error(`Failed to restore app script ${script.src || "(inline module)"}`)), { once: true });
    }) : Promise.resolve();
    (saved.placement === "head" ? document.head : document.body).append(script);
    await loaded;
  }
}

function hydrateAlpine(alpine: AlpineRuntime | undefined): void {
  if (!alpine?.initTree) return;
  const roots = Array.from(document.querySelectorAll<HTMLElement>("[x-data]"))
    .filter(element => !element.parentElement?.closest("[x-data]"));
  for (const root of roots) {
    if (!(root as HTMLElement & { _x_dataStack?: unknown })._x_dataStack) alpine.initTree(root);
  }
}

export async function restoreAppDocument(snapshot: AppDocumentSnapshot): Promise<void> {
  const restored = new DOMParser().parseFromString(snapshot.html, "text/html");
  if (restored.querySelector("script")) throw new Error("Persisted app markup must not contain script elements");

  const alpine = (window as unknown as { Alpine?: AlpineRuntime }).Alpine;
  const canPauseAlpine = Boolean(alpine?.stopObservingMutations && alpine?.startObservingMutations);
  if (canPauseAlpine) alpine!.stopObservingMutations!();

  try {
    document.title = restored.title;
    document.documentElement.lang = restored.documentElement.lang;
    document.head.querySelectorAll(":scope > :not([data-app-runtime])").forEach(node => node.remove());
    Array.from(restored.head.children).forEach(node => document.head.append(node.cloneNode(true)));
    document.body.replaceChildren(...Array.from(restored.body.childNodes).map(node => node.cloneNode(true)));

    // App-authored setup is restored only after the complete markup exists, while
    // Alpine's mutation observer is paused. Definitions/setup therefore become
    // available before we explicitly hydrate any still-uninitialized Alpine roots.
    await executeScripts(snapshot.scripts);
    hydrateAlpine(alpine);
  } finally {
    if (canPauseAlpine) alpine!.startObservingMutations!();
  }
}

export function installAutosave(
  persist: (snapshot: AppDocumentSnapshot) => void,
  delay = 750,
  storeSnapshot: () => string = () => "{}",
) {
  let timer: number | undefined;
  let suspended = false;

  const save = () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (!suspended) persist(serializeAppDocument(storeSnapshot()));
  };

  const observer = new MutationObserver(() => {
    if (suspended) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(save, delay);
  });
  observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });

  const scheduleSave = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(save, delay);
  };
  const saveOnPageHide = () => save();

  addEventListener("input", scheduleSave, true);
  addEventListener("change", scheduleSave, true);
  addEventListener("pagehide", saveOnPageHide);

  return {
    save,
    schedule: scheduleSave,
    suspend: () => { suspended = true; },
    resume: () => { suspended = false; },
    disconnect: () => {
      observer.disconnect();
      window.clearTimeout(timer);
      removeEventListener("input", scheduleSave, true);
      removeEventListener("change", scheduleSave, true);
      removeEventListener("pagehide", saveOnPageHide);
    },
  };
}
