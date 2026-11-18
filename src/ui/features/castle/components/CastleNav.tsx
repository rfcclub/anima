import { navigateAfterClick } from "../lib/navigate";

/**
 * Shared nav for every castle page. Two independent pieces, not a single
 * top toolbar:
 * - Town: a small link fixed at the top-right corner, always.
 * - Castle door: a bordered door-like button at the vertical MIDDLE of the
 *   screen edge that actually points toward the center — this is a spatial
 *   map, not a generic web app, so it reads as a real doorway, not a "back"
 *   link buried in a header bar. West Wing sits west of Castle, so its door
 *   is on the right edge (pointing east); East Wing sits east of Castle, so
 *   its door is on the left edge (pointing west).
 */
export function CastleNav({
  showBackToCentral,
  centralSide = "left",
}: {
  showBackToCentral: boolean;
  centralSide?: "left" | "right";
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => navigateAfterClick("/")}
        data-nav="town"
        className="absolute top-4 left-0 text-castle-cream text-2xl tracking-wide bg-transparent border-0 cursor-pointer hover:text-white pointer-events-auto"
        style={{ left: 40 }}
      >
        ◂ Town
      </button>
      <button
        type="button"
        onClick={() => navigateAfterClick("/vn-assets")}
        data-nav="assets"
        className="absolute top-4 text-castle-cream text-sm tracking-wide bg-transparent border-0 cursor-pointer hover:text-white pointer-events-auto z-10"
        style={{ left: 130 }}
      >
        🎨 Assets
      </button>
      <button
        type="button"
        onClick={() => navigateAfterClick("/work")}
        data-nav="work"
        className="absolute top-4 text-castle-cream text-sm tracking-wide bg-transparent border-0 cursor-pointer hover:text-white pointer-events-auto z-10"
        style={{ left: 230 }}
      >
        📋 Work
      </button>
      {showBackToCentral && (
        <button
          type="button"
          onClick={() => navigateAfterClick("/castle")}
          data-nav="central"
          className="absolute flex items-center gap-2 rounded-md border-2 border-castle-cream bg-castle-bg-translucent px-5 py-4 text-castle-cream text-2xl tracking-wide cursor-pointer hover:bg-castle-hover pointer-events-auto"
          style={{
            top: "50%",
            transform: "translateY(-50%)",
            ...(centralSide === "right" ? { right: 24 } : { left: 24 }),
          }}
        >
          {centralSide === "left" ? "◂ Castle" : "Castle ▸"}
        </button>
      )}
    </>
  );
}
