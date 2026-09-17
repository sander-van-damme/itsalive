import { ref } from "./inspect";

export async function captureScreenshot(options: { ref?: string; scale?: number } = {}): Promise<string> {
  const target = options.ref ? ref(options.ref) : document.documentElement;
  if (!(target instanceof HTMLElement)) throw new Error(options.ref ? `Unknown or non-HTML ref: ${options.ref}` : "No document element");
  const bounds = target === document.documentElement
    ? { width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, innerHeight) }
    : target.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(bounds.width));
  const height = Math.max(1, Math.ceil(bounds.height));
  const scale = Math.max(0.25, Math.min(options.scale ?? 1, 2));
  const clone = target.cloneNode(true) as HTMLElement;
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
  } finally { URL.revokeObjectURL(blobUrl); }
}
