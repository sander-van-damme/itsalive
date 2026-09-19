const RUNTIME_SELECTOR = "[data-app-runtime]";

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

export function serializeAppDocument(): string {
  normalizeControls(document);
  const html = document.documentElement.cloneNode(true) as HTMLElement;
  html.querySelectorAll(RUNTIME_SELECTOR).forEach(node => node.remove());
  return `<!doctype html>\n${html.outerHTML}`;
}

async function executeScripts(root: ParentNode) {
  for (const oldScript of Array.from(root.querySelectorAll<HTMLScriptElement>("script"))) {
    if (oldScript.hasAttribute("data-app-runtime")) continue;
    const script = document.createElement("script");
    for (const { name, value } of Array.from(oldScript.attributes)) script.setAttribute(name, value);
    script.textContent = oldScript.textContent;
    const loaded = script.src ? new Promise<void>((resolve, reject) => {
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error(`Failed to load script ${script.src}`)), { once: true });
    }) : Promise.resolve();
    oldScript.replaceWith(script);
    await loaded;
  }
}

export async function restoreAppDocument(html: string): Promise<void> {
  const restored = new DOMParser().parseFromString(html, "text/html");
  document.title = restored.title;
  document.documentElement.lang = restored.documentElement.lang;
  document.head.querySelectorAll(":scope > :not([data-app-runtime])").forEach(node => node.remove());
  Array.from(restored.head.children).forEach(node => document.head.append(node.cloneNode(true)));
  document.body.replaceChildren(...Array.from(restored.body.childNodes).map(node => node.cloneNode(true)));
  await executeScripts(document);
}

export async function restoreInitialDocument(html?: string): Promise<boolean> {
  if (!html) return false;
  await restoreAppDocument(html);
  return true;
}

export type DocumentWriter = (html: string) => Promise<void>;

export function installAutosave(writeDocument: DocumentWriter, delay = 750) {
  let timer: number | undefined;
  let suspended = false;
  let queue = Promise.resolve();

  const save = (): Promise<void> => {
    window.clearTimeout(timer);
    timer = undefined;
    if (suspended) return queue;

    const html = serializeAppDocument();
    const next = queue.catch(() => undefined).then(() => writeDocument(html));
    queue = next;
    return next;
  };

  const saveBestEffort = () => {
    void save().catch(error => console.warn("[itsalive:persistence] Autosave failed", error));
  };
  const scheduleSave = () => {
    if (suspended) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(saveBestEffort, delay);
  };

  const observer = new MutationObserver(scheduleSave);
  observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });

  addEventListener("input", scheduleSave, true);
  addEventListener("change", scheduleSave, true);
  addEventListener("pagehide", saveBestEffort);

  return {
    save,
    suspend: () => { suspended = true; window.clearTimeout(timer); timer = undefined; },
    resume: () => { suspended = false; },
    disconnect: () => {
      observer.disconnect();
      window.clearTimeout(timer);
      timer = undefined;
      removeEventListener("input", scheduleSave, true);
      removeEventListener("change", scheduleSave, true);
      removeEventListener("pagehide", saveBestEffort);
    },
  };
}
