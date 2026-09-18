const SECRET = /(?:pass(?:word|code)?|secret|token|authorization|credential|api[-_]?key|access[-_]?key|private[-_]?key)/i;
const REDACTED = "[redacted]";

export function isSensitiveName(value: string | null | undefined): boolean {
  return Boolean(value && SECRET.test(value));
}

export function isSensitiveElement(element: Element): boolean {
  return (element instanceof HTMLInputElement && (element.type === "password" || element.type === "file")) ||
    [element.getAttribute("name"), element.id, element.getAttribute("autocomplete")].some(isSensitiveName);
}

export function redactAttribute(name: string, value: string): string | undefined {
  if (isSensitiveName(name)) return REDACTED;
  if (name === "href" || name === "action") return sanitizeUrl(value);
  return value;
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value, document.baseURI);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) if (isSensitiveName(key)) url.searchParams.set(key, REDACTED);
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch { return value.slice(0, 500); }
}

export function safeControlValue(element: Element, limit = 500): string | undefined {
  if (isSensitiveElement(element)) return undefined;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value.slice(0, limit);
  return undefined;
}

export function safeKey(event: KeyboardEvent, element: Element): string | undefined {
  if (isSensitiveElement(element)) return undefined;
  return (event.key.length === 1 ? event.key : event.key.slice(0, 30));
}
