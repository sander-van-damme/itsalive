const SCREENSHOT_UNAVAILABLE_PREFIX = "[screenshot unavailable:";
const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster"] as const;

export function formatScreenshotUnavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").trim().slice(0, 240) || "capture failed";
  return `${SCREENSHOT_UNAVAILABLE_PREFIX} ${compact}]`;
}

function scrubCssResources(css: string): string {
  return css
    .replace(/@import\s+[^;]+;/gi, "")
    .replace(/url\(([^)]*)\)/gi, (match, raw: string) => {
      const value = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
      return value.startsWith("data:") || value.startsWith("#") ? match : "none";
    });
}

export function sanitizeScreenshotClone(clone: HTMLElement): HTMLElement {
  clone.querySelectorAll("script, iframe, object, embed, link").forEach(node => node.remove());
  const elements = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    for (const attribute of RESOURCE_ATTRIBUTES) element.removeAttribute(attribute);
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", scrubCssResources(style));

    if (element instanceof SVGElement) {
      const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
      if (href && !href.startsWith("#") && !href.startsWith("data:")) {
        element.removeAttribute("href");
        element.removeAttribute("xlink:href");
      }
    }
  }
  clone.querySelectorAll("style").forEach(style => {
    style.textContent = scrubCssResources(style.textContent ?? "");
  });
  return clone;
}

async function rasterize(clone: HTMLElement, width: number, height: number, scale: number): Promise<string> {
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = blobUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function captureScreenshot(options: { scale?: number } = {}): Promise<string> {
  const target = document.documentElement;
  if (!(target instanceof HTMLElement)) throw new Error("No document element");
  const width = Math.max(1, Math.ceil(Math.max(target.scrollWidth, innerWidth)));
  const height = Math.max(1, Math.ceil(Math.max(target.scrollHeight, innerHeight)));
  const scale = Math.max(0.25, Math.min(options.scale ?? 1, 2));
  const clone = target.cloneNode(true) as HTMLElement;

  try {
    return await rasterize(clone, width, height, scale);
  } catch (firstError) {
    try {
      return await rasterize(sanitizeScreenshotClone(clone.cloneNode(true) as HTMLElement), width, height, scale);
    } catch (fallbackError) {
      const first = firstError instanceof Error ? firstError.message : String(firstError);
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Screenshot capture failed (initial: ${first}; sanitized fallback: ${fallback})`);
    }
  }
}
