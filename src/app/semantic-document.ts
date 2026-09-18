import { MAX_SEMANTIC_DOCUMENT_CHARACTERS } from "../shared";
import { isSensitiveElement, redactAttribute } from "./redaction";

const OMIT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const SEMANTIC_NATIVE = new Set(["A", "BUTTON", "DETAILS", "FORM", "INPUT", "LABEL", "OPTION", "SELECT", "SUMMARY", "TEXTAREA"]);
const SAFE_ATTRIBUTES = new Set(["id", "name", "type", "role", "aria-label", "title", "href", "action", "method", "open", "checked", "selected", "disabled", "required", "placeholder"]);
const MAX_NODES = 2_000;
const MAX_TEXT = 2_000;
const MAX_DEPTH = 30;
const TRUNCATED_ATTRIBUTE = "data-semantic-truncated";

interface Budget { nodes: number; characters: number; truncated: boolean; root?: Element }
const custom = (element: Element) => element.localName.includes("-");

function addAttribute(target: Element, name: string, value: string, budget: Budget): void {
  const before = target.outerHTML.length;
  target.setAttribute(name, value);
  const added = target.outerHTML.length - before;
  if (budget.characters + added > MAX_SEMANTIC_DOCUMENT_CHARACTERS) { target.removeAttribute(name); budget.truncated = true; }
  else budget.characters += added;
}

function addText(target: Element, text: string, owner: Document, budget: Budget): void {
  const bounded = text.slice(0, MAX_TEXT);
  const encodedLength = (value: string) => {
    const scratch = owner.createElement("span");
    scratch.textContent = value;
    return scratch.innerHTML.length;
  };
  const node = owner.createTextNode(bounded);
  let added = encodedLength(bounded);
  if (budget.characters + added > MAX_SEMANTIC_DOCUMENT_CHARACTERS) {
    let low = 0, high = bounded.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (budget.characters + encodedLength(bounded.slice(0, middle)) <= MAX_SEMANTIC_DOCUMENT_CHARACTERS) low = middle; else high = middle - 1;
    }
    node.textContent = bounded.slice(0, low);
    added = encodedLength(node.textContent);
    budget.truncated = true;
  }
  if (node.textContent) { target.append(node); budget.characters += added; }
  if (text.length > MAX_TEXT) budget.truncated = true;
}

function project(source: Element, owner: Document, budget: Budget, depth = 0, parent?: Element): Element | null {
  if (OMIT.has(source.tagName) || source.hasAttribute("data-app-runtime") || source.localName === "svg" || source.localName === "itsalive-history") return null;
  if (budget.nodes >= MAX_NODES || depth > MAX_DEPTH) { budget.truncated = true; return null; }
  budget.nodes++;
  const meaningful = custom(source) || SEMANTIC_NATIVE.has(source.tagName) || source === source.ownerDocument.documentElement || source === source.ownerDocument.body || source.children.length > 0 || Boolean(source.textContent?.trim());
  if (!meaningful) return null;
  const target = owner.createElement(source.localName);
  if (!budget.root) {
    budget.root = target;
    // Reserving the marker up front guarantees that marking a truncated result cannot cross the limit.
    target.setAttribute(TRUNCATED_ATTRIBUTE, "true");
    budget.characters = target.outerHTML.length;
  }
  if (parent) {
    const added = target.outerHTML.length;
    if (budget.characters + added > MAX_SEMANTIC_DOCUMENT_CHARACTERS) { budget.truncated = true; return null; }
    parent.append(target);
    budget.characters += added;
  }
  for (const { name, value } of Array.from(source.attributes)) {
    if (name === "class" || name === "style" || name.startsWith("on") || name === TRUNCATED_ATTRIBUTE) continue;
    if (custom(source) || SAFE_ATTRIBUTES.has(name) || name.startsWith("aria-") || name.startsWith("data-state")) addAttribute(target, name, (redactAttribute(name, value) ?? "").slice(0, 500), budget);
  }
  const sensitive = isSensitiveElement(source);
  if (!sensitive) {
    if (source instanceof HTMLInputElement && source.type !== "file") addAttribute(target, "value", source.value.slice(0, 500), budget);
    if (source instanceof HTMLTextAreaElement) addText(target, source.value, owner, budget);
  }
  if (source instanceof HTMLInputElement && (source.type === "checkbox" || source.type === "radio") && source.checked) addAttribute(target, "checked", "", budget);
  if (source instanceof HTMLOptionElement && source.selected) addAttribute(target, "selected", "", budget);
  if (source instanceof HTMLDetailsElement && source.open) addAttribute(target, "open", "", budget);
  if (!sensitive) for (const node of Array.from(source.childNodes)) {
    if (budget.characters >= MAX_SEMANTIC_DOCUMENT_CHARACTERS) { budget.truncated = true; break; }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      if (text) addText(target, text, owner, budget);
    } else if (node instanceof Element) {
      project(node, owner, budget, depth + 1, target);
    }
  }
  return target;
}

/** A deterministic, bounded, lossy projection of the live HTML; never an independent state store. */
export function serializeSemanticDocument(root: Element = document.documentElement): string {
  const output = document.implementation.createHTMLDocument("");
  const budget: Budget = { nodes: 0, characters: 0, truncated: false };
  const result = project(root, output, budget);
  if (result && !budget.truncated) result.removeAttribute(TRUNCATED_ATTRIBUTE);
  return result?.outerHTML ?? "";
}
