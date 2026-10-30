import type { RuntimeQualityInspection } from "../shared/types";
export type {
  RuntimeQualityInspection,
  RuntimeQualityIssue,
} from "../shared/types";

/** Targeted checks of the current rendered view, not a WCAG conformance audit. */

type Color = [number, number, number, number];
export function parseComputedColor(value: string): Color | null {
  if (value === "transparent") return [0, 0, 0, 0];
  if (!/^rgba?\(/.test(value)) return null;
  const parts = value
    .slice(value.indexOf("(") + 1, -1)
    .trim()
    .split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4) return null;
  const rgb = parts
    .slice(0, 3)
    .map((part) => Number.parseFloat(part) * (part.endsWith("%") ? 2.55 : 1));
  const alpha = parts[3]
    ? Number.parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1)
    : 1;
  return rgb.every(Number.isFinite) && Number.isFinite(alpha)
    ? [rgb[0]!, rgb[1]!, rgb[2]!, alpha]
    : null;
}
function blend(front: Color, back: Color): Color {
  const alpha = front[3] + back[3] * (1 - front[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [
    (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
    (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
    (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
    alpha,
  ];
}
export function contrastRatio(first: Color, second: Color): number {
  const luminance = (color: Color) => {
    const linear = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function visible(element: Element, style: CSSStyleDeclaration): boolean {
  if (
    style.visibility !== "visible" ||
    style.display === "none" ||
    style.opacity === "0"
  )
    return false;
  if (element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
  if (element.closest("dialog:not([open])")) return false;
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  )
    if (getComputedStyle(parent).opacity === "0") return false;
  return [...element.getClientRects()].some(
    (rect) => rect.width > 0 && rect.height > 0,
  );
}
function location(element: Element, root: Element): string {
  const path: string[] = [];
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (current.id) {
      path.unshift(`${current.localName}#${CSS.escape(current.id)}`);
      break;
    }
    const siblings = current.parentElement
      ? [...current.parentElement.children].filter(
          (item) => item.localName === current!.localName,
        )
      : [];
    path.unshift(
      `${current.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`,
    );
    if (current === root) break;
  }
  return path.join(" > ");
}
function textAlternative(
  element: Element,
  visited = new Set<Element>(),
): string {
  if (visited.has(element)) return "";
  visited.add(element);
  if (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden")
  )
    return "";
  const references =
    element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  const referenced = references
    .map(
      (id) =>
        element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "",
    )
    .join(" ")
    .trim();
  if (referenced) return referenced;
  const label = element.getAttribute("aria-label");
  if (label?.trim()) return label.trim();
  if (element instanceof HTMLImageElement) return element.alt;
  if (element instanceof SVGElement) {
    const title = element.querySelector("title");
    if (title?.textContent?.trim()) return title.textContent.trim();
  }
  return [...element.childNodes]
    .map((node) =>
      node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? "")
        : node instanceof Element
          ? textAlternative(node, visited)
          : "",
    )
    .join(" ")
    .trim();
}
/** Conservative fallback: uncertain custom-widget naming is reported, never guessed from a role. */
function accessibleName(element: Element): string {
  const references =
    element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
  const referenced = references
    .map(
      (id) =>
        element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "",
    )
    .join(" ")
    .trim();
  if (referenced) return referenced;
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return label;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    const labels = [...(element.labels ?? [])]
      .map((item) => textAlternative(item))
      .join(" ")
      .trim();
    if (labels) return labels;
    if (element instanceof HTMLInputElement) {
      if (element.type === "image" && element.alt.trim()) return element.alt;
      if (["button", "submit", "reset"].includes(element.type))
        return (
          element.value ||
          (element.type === "submit"
            ? "Submit"
            : element.type === "reset"
              ? "Reset"
              : "")
        );
    }
    // HTML's name fallback includes title/placeholder. A persistent visible label is preferable,
    // but absence of one is not proof that the accessible name is empty.
    return (
      element.getAttribute("title")?.trim() ||
      element.getAttribute("placeholder")?.trim() ||
      ""
    );
  }
  return (
    textAlternative(element) || element.getAttribute("title")?.trim() || ""
  );
}
function backgroundFor(
  element: Element,
  layeredElements: Element[],
): { color?: Color; reason?: string } {
  const bounds = element.getBoundingClientRect();
  // DOM ancestry alone cannot establish the painted background when separate layers overlap.
  // Prefer an explicit unknown to forcing repairs based on the wrong background.
  if (
    layeredElements.some((layer) => {
      if (
        layer === element ||
        layer.contains(element) ||
        element.contains(layer)
      )
        return false;
      const rect = layer.getBoundingClientRect();
      return (
        rect.left < bounds.right &&
        rect.right > bounds.left &&
        rect.top < bounds.bottom &&
        rect.bottom > bounds.top
      );
    })
  )
    return {
      reason:
        "Overlapping positioned content requires visual contrast inspection.",
    };
  const layers: Color[] = [];
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (
      style.opacity !== "1" ||
      style.filter !== "none" ||
      style.mixBlendMode !== "normal" ||
      (style.backdropFilter && style.backdropFilter !== "none")
    )
      return {
        reason:
          "Opacity, a filter or blending requires visual contrast inspection.",
      };
    if (style.backgroundImage !== "none")
      return {
        reason:
          "The text uses an image or gradient background; inspect contrast visually.",
      };
    for (const pseudo of ["::before", "::after"]) {
      const decoration = getComputedStyle(current, pseudo);
      if (
        decoration.content !== "none" &&
        decoration.content !== "normal" &&
        decoration.display !== "none"
      ) {
        const color = parseComputedColor(decoration.backgroundColor);
        if (decoration.backgroundImage !== "none" || (color && color[3] > 0))
          return {
            reason: "A generated decoration may affect the text background.",
          };
      }
    }
    const color = parseComputedColor(style.backgroundColor);
    if (!color)
      return {
        reason:
          "The browser color space is not supported by this contrast check.",
      };
    layers.push(color);
    if (color[3] === 1) {
      let resolved = color;
      for (const layer of layers.slice(0, -1).reverse())
        resolved = blend(layer, resolved);
      // Even a solid element participates in ancestor opacity/filter compositing.
      for (
        let ancestor = current.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const outer = getComputedStyle(ancestor);
        if (
          outer.opacity !== "1" ||
          outer.filter !== "none" ||
          outer.mixBlendMode !== "normal"
        )
          return {
            reason:
              "Ancestor opacity, filtering or blending requires visual contrast inspection.",
          };
      }
      return { color: resolved };
    }
  }
  return {
    reason:
      "No explicit solid background was available; browser canvas contrast was not assumed.",
  };
}

export function inspectQuality(root: Element): RuntimeQualityInspection {
  const result: RuntimeQualityInspection = {
    issues: [],
    inconclusive: [],
    checkedTextElements: 0,
    checkedControls: 0,
    scope: "visible-current-view",
  };
  const controls =
    "button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=textbox],[role=combobox],[role=slider],[role=spinbutton],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem]";
  const elements = [root, ...root.querySelectorAll("*")];
  const layeredElements = [...root.ownerDocument.querySelectorAll("*")].filter(
    (element) => {
      const style = getComputedStyle(element);
      if (
        !["absolute", "fixed", "sticky"].includes(style.position) ||
        !visible(element, style)
      )
        return false;
      const color = parseComputedColor(style.backgroundColor);
      return (
        style.backgroundImage !== "none" ||
        !!(color && color[3] > 0) ||
        ["IMG", "CANVAS", "SVG", "VIDEO"].includes(
          element.tagName.toUpperCase(),
        )
      );
    },
  );
  for (const element of elements) {
    if (
      !(element instanceof HTMLElement) ||
      ["SCRIPT", "STYLE", "OPTION", "NOSCRIPT"].includes(element.tagName)
    )
      continue;
    const style = getComputedStyle(element);
    if (!visible(element, style)) continue;
    const target = location(element, root);
    if (element.matches("dialog,[role=dialog],[role=alertdialog]")) {
      const labelled =
        element.getAttribute("aria-label")?.trim() ||
        element
          .getAttribute("aria-labelledby")
          ?.trim()
          .split(/\s+/)
          .some((id) =>
            element.ownerDocument.getElementById(id)?.textContent?.trim(),
          ) ||
        element.title.trim();
      if (!labelled)
        result.issues.push({
          code: "dialog-name",
          severity: "error",
          element: target,
          message:
            "Give this dialog an accessible name using aria-labelledby or aria-label.",
        });
    }
    const disabled = !!element.closest(":disabled,[aria-disabled=true]");
    if (element.matches(controls) && !disabled) {
      result.checkedControls++;
      if (!accessibleName(element)) {
        const generatedName = ["::before", "::after"].some((pseudo) => {
          const content = getComputedStyle(element, pseudo).content;
          return content && !["none", "normal", '""', "''"].includes(content);
        });
        if (generatedName)
          result.inconclusive.push({
            element: target,
            reason:
              "Generated content may contribute to this control's accessible name; inspect its accessibility tree.",
          });
        else
          result.issues.push({
            code: "control-name",
            severity: "error",
            element: target,
            message:
              "This interactive control has no accessible name. Add a label or an appropriate text alternative.",
          });
      }
    }
    const hasText =
      [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
      ) ||
      (element instanceof HTMLInputElement &&
        !!element.value &&
        !["hidden", "checkbox", "radio", "range", "color"].includes(
          element.type,
        ));
    if (!hasText || disabled) continue;
    result.checkedTextElements++;
    const size = Number.parseFloat(style.fontSize);
    if (size < 14)
      result.issues.push({
        code: "small-text",
        severity: "warning",
        element: target,
        message:
          "This text is smaller than the preferred readable default. Check that it is secondary and remains comfortable at zoom.",
        actual: size,
        expected: "Normally at least 14px for labels and 16px for body text.",
      });
    const background = backgroundFor(element, layeredElements);
    const foreground = parseComputedColor(style.color);
    if (!background.color || !foreground) {
      result.inconclusive.push({
        element: target,
        reason:
          background.reason ??
          "The foreground color space is not supported by this contrast check.",
      });
      continue;
    }
    if (
      style.textShadow !== "none" ||
      style.webkitTextStrokeWidth !== "0px" ||
      style.backgroundClip === "text" ||
      (style.webkitTextFillColor && style.webkitTextFillColor !== style.color)
    ) {
      result.inconclusive.push({
        element: target,
        reason:
          "Text shadow, outline or clipping requires visual contrast inspection.",
      });
      continue;
    }
    const ratio = contrastRatio(
      blend(foreground, background.color),
      background.color,
    );
    const minimum =
      size >= 24 ||
      (size >= 18.6667 && Number.parseInt(style.fontWeight, 10) >= 700)
        ? 3
        : 4.5;
    if (ratio + 0.001 < minimum)
      result.issues.push({
        code: "text-contrast",
        severity: "error",
        element: target,
        message: `Visible text contrast is ${ratio.toFixed(2)}:1; use at least ${minimum}:1 for this text size.`,
        actual: Number(ratio.toFixed(3)),
        expected: minimum,
      });
  }
  return result;
}
