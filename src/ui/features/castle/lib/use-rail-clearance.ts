import { useCallback, useEffect, useState } from "react";
import { railClearanceUnits } from "./bubble-layout";

/** Default clearance, in canvas units, until the rail has been measured. */
const DEFAULT_CLEARANCE = 190;
const RAIL_SELECTOR = '[data-testid="addressee-rail"]';

/** Measures the addressee rail against the HTML layer and returns how many canvas units of the left edge the
 *  bubbles must keep clear. Put `probe` (a callback ref) on a child of the layer that fills it, so its rectangle
 *  is the layer's. The layer is rendered by a nested root that mounts after this component, and the rail can come
 *  and go with the occupants, so the measuring starts when the probe attaches and a `MutationObserver` on the layer
 *  re-measures when the rail appears, changes or leaves; a `ResizeObserver` covers window and rail size changes. */
export function useRailClearance() {
  const [probeEl, setProbeEl] = useState<HTMLDivElement | null>(null);
  const [minLeft, setMinLeft] = useState(DEFAULT_CLEARANCE);
  const probe = useCallback((el: HTMLDivElement | null) => setProbeEl(el), []);
  useEffect(() => {
    const layer = probeEl?.parentElement;
    if (!probeEl || !layer) return;
    let observedRail: Element | null = null;
    const resize = new ResizeObserver(() => measure());
    function measure() {
      const rail = layer!.querySelector<HTMLElement>(RAIL_SELECTOR);
      if (rail !== observedRail) {
        if (observedRail) resize.unobserve(observedRail);
        if (rail) resize.observe(rail);
        observedRail = rail;
      }
      const box = probeEl!.getBoundingClientRect();
      if (box.width <= 0) return;
      const next = rail ? railClearanceUnits(rail.getBoundingClientRect().right, box.left, box.width) : DEFAULT_CLEARANCE;
      setMinLeft((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    }
    resize.observe(layer);
    const mutations = new MutationObserver(measure);
    mutations.observe(layer, { childList: true, subtree: true });
    measure();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [probeEl]);
  return { probe, minLeft };
}
