/** Shared inline-style tokens for castle room components.
 *
 * WHY THIS EXISTS: The /rooms/:agent screen renders its React UI inside a
 * detached HTML layer (Pixi'VN's addHtmlLayer) that mounts its own React
 * root OUTSIDE the app's normal DOM tree. In that detached subtree, Tailwind
 * utility classes intermittently do not apply (the built CSS is served
 * correctly — verified 112KB with utilities — but the detached root does not
 * reliably pick them up). So every room overlay component MUST carry its own
 * inline styles for position/padding/border/background/color/z-index instead
 * of relying on Tailwind. Keep the hex values here in sync with the Tailwind
 * @theme tokens in src/ui/styles/tailwind.css. */
export const CASTLE = {
  bg: "#1a1410",
  bgTranslucent: "#1a1410cc",
  panel: "#241c14",
  panelTranslucent: "#241c1480",
  hover: "#2a2015cc",
  cream: "#e8d8b0",
  creamFaint: "#e8d8b055",
  parchment: "#f0e6d2",
  muted: "#8a7a5f",
  dim: "#5a4f3a",
} as const;

export type CastStyle = Record<string, string | number>;
