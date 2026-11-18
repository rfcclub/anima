import { useState } from "react";
import type { ViewId } from "../lib/settings";
import type { ResolvedEndpoints } from "../lib/endpoints";

interface Props {
  active: ViewId | null;
  endpoints: ResolvedEndpoints | null;
  /** Bump to force-reload every iframe (manual refresh / recovery). */
  reloadToken: number;
  overlay: "reconnecting" | null;
}

const VIEWS: ViewId[] = ["town", "openclaw", "chat"];

/**
 * Hosts all three view iframes simultaneously; switching views toggles
 * visibility so each iframe keeps its state.
 */
export function IframeHost({ active, endpoints, reloadToken, overlay }: Props) {
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});

  if (!endpoints) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm"
        style={{ color: "var(--muted)" }}
      >
        No endpoints — check the active profile in Settings.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" style={{ background: "var(--bg)" }}>
      {VIEWS.map((view) => {
        const src = endpoints[view];
        const key = `${view}:${src}:${reloadToken}`;
        const visible = active === view;
        return (
          <div
            key={view}
            className="absolute inset-0"
            style={{
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {!loaded[key] && (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center"
                style={{ background: "var(--bg)" }}
              >
                <div className="spinner" />
              </div>
            )}
            <iframe
              key={key}
              src={src}
              title={view}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
              onLoad={() => setLoaded((l) => ({ ...l, [key]: true }))}
            />
          </div>
        );
      })}

      {overlay === "reconnecting" && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3"
          style={{ background: "color-mix(in srgb, var(--bg) 82%, transparent)" }}
        >
          <div className="spinner" />
          <div className="text-sm" style={{ color: "var(--muted)" }}>
            Reconnecting…
          </div>
        </div>
      )}
    </div>
  );
}
