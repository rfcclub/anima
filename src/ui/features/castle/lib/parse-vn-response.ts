/**
 * UI-facing VN response parser. The parsing logic lives in the framework-free
 * seam `src/narrative/vn-response.ts` (shared with the server, so decline
 * detection + follow-up context use the same code path). This module
 * re-exports it and keeps the DOM-bound `renderMarkdown` local — that one
 * needs `marked` + `DOMPurify` and must never run on the server.
 *
 * See SC-502 (meeting decline protocol).
 */
export {
  parseVNResponse,
  extractSpokenText,
  detectDecline,
  renderVNText,
} from "../../../../narrative/vn-response";
export type { ParsedVNResponse, VNChoice } from "../../../../narrative/vn-response";

import { marked } from "marked";
import * as DOMPurifyNS from "dompurify";

// marked v18 returns a Promise by default; force synchronous parse so it can
// be used directly inside render(). GFM on so **bold**, `code`, and lists work.
marked.setOptions({ async: false, gfm: true });

// dompurify v20 exports a factory; in the browser it auto-binds to `window`,
// but in a non-DOM test env it needs a window-like object. Resolve the factory
// (default export shape varies between ESM/CJS) and create the instance
// defensively so importing this module never crashes without a DOM.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dp = DOMPurifyNS as any;
const DOMPurifyFactory = dp.default ?? dp;
const DOMPurify = DOMPurifyFactory
  ? DOMPurifyFactory(typeof window !== "undefined" ? window : undefined)
  : undefined;

/** Parse markdown → sanitized HTML for inline display in room overlays. Output
 *  is run through DOMPurify so any raw HTML embedded in the markdown (e.g. an
 *  agent reply containing <script> or an <img onerror=...>) is stripped before
 *  it reaches dangerouslySetInnerHTML — defense-in-depth even though the source
 *  is our own agent output. When no DOM is available, falls back to the raw
 *  marked output (server-side rendering of agent text does not happen today). */
export function renderMarkdown(md: string): string {
  if (!md) return "";
  const html = marked.parse(md) as string;
  return DOMPurify && typeof DOMPurify.sanitize === "function"
    ? DOMPurify.sanitize(html)
    : html;
}
