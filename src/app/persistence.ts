import { dbGet, dbSet, STORES } from "./db";

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

export async function loadSavedDocument() {
  const html = await dbGet<string>(STORES.document, "html");
  if (html) await restoreAppDocument(html);
  return Boolean(html);
}

export function installAutosave(delay = 750) {
  let timer: number | undefined;
  let suspended = false;
  const save = async () => {
    window.clearTimeout(timer);
    timer = undefined;
    if (!suspended) await dbSet(STORES.document, "html", serializeAppDocument());
  };
  const observer = new MutationObserver(() => {
    if (suspended) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), delay);
  });
  observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
  addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(() => void save(), delay); }, true);
  addEventListener("change", () => { window.clearTimeout(timer); timer = window.setTimeout(() => void save(), delay); }, true);
  addEventListener("pagehide", () => void save());
  return { save, suspend: () => { suspended = true; }, resume: () => { suspended = false; }, disconnect: () => observer.disconnect() };
}
