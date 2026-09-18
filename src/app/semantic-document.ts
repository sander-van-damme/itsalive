const OMIT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const SEMANTIC_NATIVE = new Set(["A", "BUTTON", "DETAILS", "FORM", "INPUT", "LABEL", "OPTION", "SELECT", "SUMMARY", "TEXTAREA"]);
const SAFE_ATTRIBUTES = new Set(["id", "name", "type", "role", "aria-label", "title", "href", "action", "method", "open", "checked", "selected", "disabled", "required", "placeholder"]);
import { isSensitiveElement, redactAttribute } from "./redaction";

const MAX_NODES = 2_000;
const MAX_TEXT = 2_000;
const MAX_DEPTH = 30;

function custom(element: Element): boolean { return element.localName.includes("-"); }
function project(source: Element, owner: Document, budget: { nodes: number; truncated: boolean }, depth = 0): Element | null {
  if (OMIT.has(source.tagName) || source.hasAttribute("data-app-runtime") || source.localName === "svg" || source.localName === "itsalive-history") return null;
  if (budget.nodes >= MAX_NODES || depth > MAX_DEPTH) { budget.truncated = true; return null; }
  budget.nodes++;
  const meaningful = custom(source) || SEMANTIC_NATIVE.has(source.tagName) || source === source.ownerDocument.documentElement || source === source.ownerDocument.body || source.children.length > 0 || Boolean(source.textContent?.trim());
  if (!meaningful) return null;
  const target = owner.createElement(source.localName);
  for (const { name, value } of Array.from(source.attributes)) {
    if (name === "class" || name === "style" || name.startsWith("on")) continue;
    if (custom(source) || SAFE_ATTRIBUTES.has(name) || name.startsWith("aria-") || name.startsWith("data-state")) target.setAttribute(name, (redactAttribute(name, value) ?? "").slice(0, 500));
  }
  if (!isSensitiveElement(source)) {
    if (source instanceof HTMLInputElement && source.type !== "file") target.setAttribute("value", source.value.slice(0, 500));
    if (source instanceof HTMLTextAreaElement) target.textContent = source.value.slice(0, 2_000);
  }
  if (source instanceof HTMLInputElement && (source.type === "checkbox" || source.type === "radio")) target.toggleAttribute("checked", source.checked);
  if (source instanceof HTMLOptionElement) target.toggleAttribute("selected", source.selected);
  if (source instanceof HTMLDetailsElement) target.toggleAttribute("open", source.open);
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (text) { if (text.length > MAX_TEXT) budget.truncated = true; target.append(owner.createTextNode(text.slice(0, MAX_TEXT))); }
    } else if (node instanceof Element) {
      const child = project(node, owner, budget, depth + 1); if (child) target.append(child);
    }
  }
  return target;
}

/** A deterministic, lossy projection of the live HTML; never an independent state store. */
export function serializeSemanticDocument(root: Element = document.documentElement): string {
  const output = document.implementation.createHTMLDocument("");
  const budget = { nodes: 0, truncated: false };
  const result = project(root, output, budget);
  if (result && budget.truncated) result.setAttribute("data-semantic-truncated", "true");
  return result?.outerHTML ?? "";
}
