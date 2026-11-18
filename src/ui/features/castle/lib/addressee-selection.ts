/** Sticky addressee selection for the meeting room — pure, framework-free
 *  so it's unit-testable without React/RTL (this stack has neither). */
export type Addressee =
  | { kind: "none" }
  | { kind: "agent"; id: string }
  | { kind: "all" }
  | { kind: "order"; order: string[] };

/** Clicking an occupant always sets the selection (never toggles it off) —
 *  replaces whatever was selected before, including "all". */
export function selectAddressee(_current: Addressee, clicked: string): Addressee {
  return { kind: "agent", id: clicked };
}

/** Pressing "All" replaces any individual selection with the all-mode. */
export function selectAll(): Addressee {
  return { kind: "all" };
}

/** Picking an ordering button (e.g. "Bruno-Eli") replaces any prior
 *  selection with an explicit N-way speaking order, replacing the single
 *  "All" button with {{owner}}-{{guest}} / {{guest}}-{{owner}} pairings. */
export function selectOrder(order: string[]): Addressee {
  return { kind: "order", order };
}

/** The value to send as the request body's `addressee` field. */
export function addresseeField(a: Addressee): string | undefined {
  if (a.kind === "none") return undefined;
  if (a.kind === "all") return "all";
  if (a.kind === "order") return a.order.join(",");
  return a.id;
}

/** Swap the clicked agent into stage position 0, swapping whoever was
 *  there into the clicked agent's old slot. No-op if the clicked agent is
 *  already first, or isn't present in the list. */
export function computeSwapOrder(current: string[], clicked: string): string[] {
  const clickedIndex = current.indexOf(clicked);
  if (clickedIndex <= 0) return current;
  const next = [...current];
  [next[0], next[clickedIndex]] = [next[clickedIndex], next[0]];
  return next;
}

/** All available speaking orders for the ordering buttons — owner-led
 *  (the original "All" shape) plus one guest-led option per guest
 *  (that guest leads, owner follows immediately, remaining guests keep
 *  their relative order). Capped at 3 total options (an explicit
 *  cap for now). Empty if the owner is alone, OR
 *  if the owner isn't actually present (case 5) — every option here
 *  pairs a guest with the owner, so without a present owner there's
 *  nothing valid to build. Requirement: do not fabricate an
 *  absent owner into an ordering (a room without its owner must not offer
 *  owner-guest pairings). */
export function computeOrderingOptions(occupants: string[], ownerId: string): string[][] {
  if (!occupants.includes(ownerId)) return [];
  const guests = occupants.filter((a) => a !== ownerId);
  if (guests.length === 0) return [];
  const options: string[][] = [[ownerId, ...guests]];
  for (let i = 0; i < guests.length; i++) {
    const leader = guests[i];
    const rest = guests.filter((_, idx) => idx !== i);
    options.push([leader, ownerId, ...rest]);
  }
  return options.slice(0, 3);
}

/** Reset a sticky selection against the live occupant list so the stage,
 *  waiting bubble, and server never disagree about who will speak.
 *
 *  - `kind:"agent"` — if the selected id is no longer present, return `none`
 *    (SC-304). Otherwise unchanged (SC-305).
 *  - `kind:"order"` — filter the order to ids still present, preserving
 *    relative order. If fewer than 2 remain, return `none` — an order needs
 *    ≥2 speakers; a single survivor is no longer an ordering (SC-301, SC-303).
 *    All present → unchanged (SC-302).
 *  - `kind:"none"` and `kind:"all"` — unchanged.
 *
 *  Reset (not preserve-intent): single-user product; re-selecting is one
 *  click. Matches "presence routes; it does not multiply." */
export function reconcileAddressee(a: Addressee, occupants: string[]): Addressee {
  if (a.kind === "agent") {
    return occupants.includes(a.id) ? a : { kind: "none" };
  }
  if (a.kind === "order") {
    const surviving = a.order.filter((id) => occupants.includes(id));
    return surviving.length >= 2 ? { kind: "order", order: surviving } : { kind: "none" };
  }
  return a;
}
