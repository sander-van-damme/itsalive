# Rendered application quality checks

The coding harness receives measurable evidence from the rendered candidate before publishing it. Runtime inspection reports contrast, interactive-control names and dialog names alongside runtime errors. Confirmed errors return to the worker as a failed `quality` check; `finish` cannot commit that candidate until a later inspection passes. The ordinary inspection tool exposes the same evidence for investigating an existing app.

Contrast checks use computed text color, font size/weight and explicitly resolvable solid backgrounds, including transparent solid layers. The threshold is 4.5:1 for normal text and 3:1 for large text under WCAG's size definition. Inactive controls and hidden content are excluded. Text below 14px produces a readability warning, not an automatic failure: small secondary content can be appropriate, and WCAG does not prescribe a universal minimum font size.

The check deliberately reports uncertainty for gradients, images, overlapping positioned paint, unsupported color spaces, opacity/filter/blending, text outlines and generated decorations. It does not assume the browser canvas color. Name checks recognize native labels, ARIA references, text alternatives and common native defaults; CSS-generated names remain inconclusive for accessibility-tree review. Warnings and uncertain results are returned to the worker without being presented as confirmed defects.

These are checks of the current rendered view, not WCAG certification or a substitute for usability review. They do not automatically traverse every route, open every dialog, assess all keyboard interactions, verify focus containment/Escape behavior, measure control contrast, judge whether copy is useful or validate task relevance. The generation contract still requires those outcomes; representative keyboard, screen-reader, zoom, narrow-screen, light/dark and real-model reviews remain necessary. Source restored from version history is retained as requested; these coding-harness checks do not silently rewrite historical versions.

## Evidence

- `tests/runtime-quality.test.ts` checks parsing and WCAG relative-luminance calculation.
- `tests/ai-harness.test.ts` verifies that a confirmed contrast error returns to the worker, the first candidate is not committed, and a repaired candidate with advisory small text can commit.
- `e2e/quality-review.spec.ts` exercises actual Chromium computed styles, native/ARIA naming, hidden/inactive content, alpha backgrounds, large-text thresholds and uncertain layered content. Its full pipeline scenario supplies a low-contrast candidate through the normal provider adapter, observes the measured failure reaching the worker, repairs it and verifies that only the readable application is published.

The browser tests use deterministic provider replies. They establish the verification and repair path, not the aesthetic quality, empathy or accessibility of arbitrary future model output.
