import type {
  RuntimeRegion,
  WorkActivity,
  WorkActivityResult,
} from "../shared/types";

/** Exact DOM ownership for visible-work markers. Models receive opaque region IDs,
 * not permission to inject selectors or HTML into the runtime. */
export class ActivityRegions {
  private ids = new WeakMap<HTMLElement, string>();
  private readonly elements = new Map<string, HTMLElement>();
  private readonly identity = crypto.randomUUID();
  private sequence = 0;
  private overlays: Array<{
    element: HTMLElement;
    overlay: HTMLElement;
    inert: boolean;
    busy: string | null;
  }> = [];
  private resize?: ResizeObserver;
  private mutation?: MutationObserver;
  private host?: HTMLElement;
  private cleanupListeners?: () => void;

  constructor(private readonly application: HTMLElement) {}

  inspect(): RuntimeRegion[] {
    const regions: RuntimeRegion[] = [];
    this.elements.clear();
    const candidates = this.application.querySelectorAll<HTMLElement>(
      "section,article,nav,form,fieldset,dialog[open],button,a[href],input:not([type=hidden]),select,textarea,[role=region],[role=group],[role=button],[role=tab],[role=dialog],[data-work-region]",
    );
    for (const element of candidates) {
      if (!this.visible(element)) continue;
      let id = this.ids.get(element);
      if (!id) {
        // Verification runtimes and other apps can contain identical DOM trees.
        // Their region receipts must never accidentally address this runtime.
        id = `region-${this.identity}-${++this.sequence}`;
        this.ids.set(element, id);
      }
      this.elements.set(id, element);
      const labelledBy = element
        .getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      const labelled =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
          ? [...(element.labels ?? [])]
              .map((label) => label.textContent ?? "")
              .join(" ")
              .trim()
          : "";
      const heading = element
        .querySelector("h1,h2,h3,h4,legend")
        ?.textContent?.trim();
      const role =
        element.getAttribute("role") ?? element.tagName.toLowerCase();
      // Labels are semantic context, not the full application text (returned separately).
      const label =
        element.getAttribute("aria-label")?.trim() ||
        labelledBy ||
        labelled ||
        heading ||
        (element.matches("button,a,[role=button],[role=tab]")
          ? element.textContent?.trim()
          : "") ||
        element.getAttribute("title") ||
        element.getAttribute("name") ||
        role;
      regions.push({ id, label, role });
    }
    return regions;
  }

  show(activity: WorkActivity): WorkActivityResult {
    this.clear();
    const resolved: string[] = [];
    const rejected: string[] = [];
    const selected = new Map<HTMLElement, string>();
    for (const id of new Set(activity.targets)) {
      const element = this.elements.get(id);
      if (
        !element ||
        !this.application.contains(element) ||
        !this.visible(element)
      ) {
        rejected.push(id);
      } else selected.set(element, id);
    }
    // A parent marker already covers its requested descendants. Avoid stacked fog.
    for (const [element, id] of selected) {
      resolved.push(id);
      if (
        [...selected.keys()].some(
          (parent) => parent !== element && parent.contains(element),
        )
      )
        continue;
      const overlay = document.createElement("div");
      overlay.dataset.itsaliveActivity = id;
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        boxSizing: "border-box",
        borderRadius: "10px",
        border: "1px solid rgba(85,133,156,.5)",
        background: "rgba(191,220,230,.3)",
        backdropFilter: "blur(3px)",
        pointerEvents: "auto",
        zIndex: "2147483646",
        overflow: "hidden",
        transition: "opacity 160ms ease",
        cursor: "progress",
      });
      const shimmer = document.createElement("div");
      Object.assign(shimmer.style, {
        height: "3px",
        width: "100%",
        position: "absolute",
        inset: "0 0 auto",
        background: "linear-gradient(90deg,transparent,#3c819c,transparent)",
      });
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
        shimmer.animate(
          [
            { transform: "translateX(-100%)" },
            { transform: "translateX(100%)" },
          ],
          { duration: 2200, iterations: Infinity },
        );
      overlay.append(shimmer);
      this.overlays.push({
        element,
        overlay,
        inert: element.inert,
        busy: element.getAttribute("aria-busy"),
      });
      element.inert = true;
      element.setAttribute("aria-busy", "true");
    }
    if (!this.overlays.length) return { resolved, rejected };
    this.host = document.createElement("div");
    this.host.dataset.itsaliveActivityHost = "true";
    this.host.style.setProperty("pointer-events", "none");
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.textContent = activity.message;
    Object.assign(status.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
    });
    this.host.append(status);
    document.body.append(this.host);
    for (const { element, overlay } of this.overlays) {
      // Native modal dialogs live in the top layer, above document z-index.
      // Keep their precise marker in the same layer instead of behind the modal.
      const dialog = element.closest<HTMLDialogElement>("dialog[open]");
      (dialog ?? this.host).append(overlay);
    }
    const update = () => this.position();
    this.resize = new ResizeObserver(update);
    for (const { element } of this.overlays) this.resize.observe(element);
    this.mutation = new MutationObserver(update);
    this.mutation.observe(this.application, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    this.cleanupListeners = () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    this.position();
    return { resolved, rejected };
  }

  clear(): void {
    this.resize?.disconnect();
    this.mutation?.disconnect();
    this.cleanupListeners?.();
    this.resize = undefined;
    this.mutation = undefined;
    this.cleanupListeners = undefined;
    for (const { element, inert, busy, overlay } of this.overlays) {
      element.inert = inert;
      if (busy === null) element.removeAttribute("aria-busy");
      else element.setAttribute("aria-busy", busy);
      overlay
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.cancel());
      overlay.remove();
    }
    this.overlays = [];
    this.host?.remove();
    this.host = undefined;
  }

  /** Even when React reuses a DOM node, an applied revision can change its
   * meaning. Require a fresh inspection before marking the new revision. */
  invalidate(): void {
    this.clear();
    this.elements.clear();
    this.ids = new WeakMap();
  }

  private visible(element: HTMLElement) {
    return (
      element.isConnected &&
      element.getClientRects().length > 0 &&
      (typeof element.checkVisibility !== "function" ||
        element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })) &&
      getComputedStyle(element).visibility !== "hidden"
    );
  }

  private position() {
    for (const { element, overlay } of this.overlays) {
      if (!this.application.contains(element) || !this.visible(element)) {
        overlay.hidden = true;
        continue;
      }
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left),
        top = Math.max(0, rect.top);
      let right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom);
      // A scrolled or clipped section must not cover unrelated controls outside
      // its visible scroll container merely because its layout box is larger.
      for (
        let parent = element.parentElement;
        parent && parent !== document.body;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent),
          bounds = parent.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      overlay.hidden = width === 0 || height === 0;
      Object.assign(overlay.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
      });
    }
  }
}
