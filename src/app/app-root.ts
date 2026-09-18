export const APP_ROOT_ID = "itsalive-root";

const ALLOWED_OUTSIDE_ROOT_SELECTOR = "[data-app-runtime], itsalive-history, script, style, link, template, noscript";

function roots(ownerDocument: Document): HTMLElement[] {
  return Array.from(ownerDocument.querySelectorAll<HTMLElement>(`[id="${APP_ROOT_ID}"]`));
}

function allowedOutsideRoot(node: Node): boolean {
  if (node.nodeType === Node.COMMENT_NODE) return true;
  if (node.nodeType === Node.TEXT_NODE) return !(node.textContent?.trim());
  if (!(node instanceof Element)) return true;
  return node.matches(ALLOWED_OUTSIDE_ROOT_SELECTOR);
}

function outsideAppNodes(ownerDocument: Document, root: HTMLElement): Node[] {
  return Array.from(ownerDocument.body.childNodes).filter(node => node !== root && !allowedOutsideRoot(node));
}

function describeNode(node: Node): string {
  if (!(node instanceof Element)) return node.nodeType === Node.TEXT_NODE ? "#text" : node.nodeName;
  return `<${node.localName}${node.id ? `#${node.id}` : ""}>`;
}

export function ensureCanonicalAppRoot(ownerDocument: Document = document): HTMLElement {
  const body = ownerDocument.body;
  const existing = roots(ownerDocument);
  let root = existing.find(node => node.parentElement === body) ?? existing[0];

  if (!root) {
    root = ownerDocument.createElement("div");
    root.id = APP_ROOT_ID;
    body.prepend(root);
  } else if (root.parentElement !== body) {
    body.prepend(root);
  }

  for (const duplicate of roots(ownerDocument)) {
    if (duplicate === root) continue;
    while (duplicate.firstChild) root.append(duplicate.firstChild);
    duplicate.remove();
  }

  for (const node of outsideAppNodes(ownerDocument, root)) root.append(node);
  return root;
}

export function enforceCanonicalAppRootAfterAgentCommand(ownerDocument: Document = document): void {
  const body = ownerDocument.body;
  const currentRoots = roots(ownerDocument);
  const root = currentRoots.find(node => node.parentElement === body);

  if (currentRoots.length !== 1 || !root) {
    ensureCanonicalAppRoot(ownerDocument);
    throw new Error("Generated command must preserve exactly one direct #itsalive-root. The runtime repaired the root; continue by editing that canonical element instead of replacing it.");
  }

  const outside = outsideAppNodes(ownerDocument, root);
  if (!outside.length) return;

  const description = outside.map(describeNode).join(", ");
  for (const node of outside) node.parentNode?.removeChild(node);
  throw new Error(`Generated command appended user-visible UI outside #itsalive-root (${description}). Those nodes were discarded; repair by editing the existing canonical root.`);
}
