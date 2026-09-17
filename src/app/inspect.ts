const references = new Map<string, Element>();
let referenceCounter = 0;

const refFor = (element: Element) => {
  for (const [key, value] of references) if (value === element) return key;
  const key = `@${++referenceCounter}`;
  references.set(key, element);
  return key;
};

export function ref(id: string): Element | null {
  const element = references.get(id);
  if (!element?.isConnected) { references.delete(id); return null; }
  return element;
}

function label(element: Element, source: boolean) {
  const key = refFor(element);
  let descriptor = element.tagName.toLowerCase();
  if (element.id) descriptor += `#${element.id}`;
  const classes = Array.from(element.classList).slice(0, 3);
  if (classes.length) descriptor += `.${classes.join(".")}`;
  if (source) return `${key} ${descriptor}\n${element.outerHTML}`;
  if (element.matches("script,style")) return `${key} ${descriptor} [${new Blob([element.textContent ?? ""]).size} B]`;
  const ownText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent?.trim()).filter(Boolean).join(" ");
  return `${key} ${descriptor}${ownText ? ` "${ownText.slice(0, 120)}${ownText.length > 120 ? "…" : ""}"` : ""}`;
}

function compactTree(root: Element, maxDepth = 6, maxNodes = 250): string {
  const lines: string[] = [];
  let count = 0;
  const visit = (element: Element, depth: number, trail: boolean[]) => {
    if (++count > maxNodes) return;
    lines.push(`${trail.map(last => last ? "   " : "│  ").join("")}${depth ? (trail.at(-1) ? "└─ " : "├─ ") : ""}${label(element, false)}`);
    if (depth >= maxDepth) return;
    const children = Array.from(element.children).filter(child => !child.hasAttribute("data-app-runtime"));
    children.forEach((child, index) => visit(child, depth + 1, [...trail, index === children.length - 1]));
  };
  visit(root, 0, []);
  if (count > maxNodes) lines.push(`… truncated after ${maxNodes} nodes`);
  return lines.join("\n");
}

export async function inspectDom(options: { ref?: string; search?: string; detail?: "source"; maxDepth?: number; maxNodes?: number } = {}) {
  let root: Element = document.body;
  if (options.ref) {
    const target = ref(options.ref);
    if (!target) throw new Error(`Unknown or stale DOM reference: ${options.ref}`);
    root = target;
  }
  if (options.search) {
    const needle = options.search.toLocaleLowerCase();
    const matches = [root, ...Array.from(root.querySelectorAll("*"))].filter(element =>
      !element.matches("script,style") && (element.textContent ?? "").toLocaleLowerCase().includes(needle));
    const mostSpecific = matches.filter(element => !Array.from(element.children).some(child => (child.textContent ?? "").toLocaleLowerCase().includes(needle)));
    return mostSpecific.slice(0, 50).map(element => label(element, options.detail === "source")).join("\n\n") || "No matches";
  }
  if (options.detail === "source") return label(root, true);
  return compactTree(root, options.maxDepth, options.maxNodes);
}
