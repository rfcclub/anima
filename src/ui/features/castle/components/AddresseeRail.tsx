import { CASTLE } from "../lib/castle-style";
import { computeOrderingOptions, type Addressee } from "../lib/addressee-selection";

/** Left-side vertical button rail — click an occupant to make them the
 *  explicit addressee for the next message (bypasses substring name
 *  detection). Below that, one
 *  ordering button per speaking order (owner-led — the original "All"
 *  — plus one guest-led order per guest, capped at 3 total; the labels read
 *  {{owner}}-{{guest}} / {{guest}}-{{owner}}).
 *  No internal state — RoomScreen owns the `Addressee` value.
 *
 *  Styles inline — same detached-HTML-layer constraint as the rest of the
 *  room overlay, see castle-style.ts. */
export function AddresseeRail({
  occupants,
  ownerId,
  addressee,
  activeSpeakerId,
  onSelect,
  onSelectOrder,
}: {
  occupants: string[];
  ownerId: string;
  addressee: Addressee;
  /** Resolved default (owner if present, else primary guest) used to
   *  highlight the implicit selection when nothing's been clicked yet —
   *  requirement: default to the owner when present; with a guest but no
   *  owner, pick the guest. Always show the rail, even alone in the room,
   *  so who's-active is never ambiguous. */
  activeSpeakerId: string;
  onSelect: (id: string) => void;
  onSelectOrder: (order: string[]) => void;
}) {
  if (occupants.length === 0) return null; // empty room — nothing to address

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const orderingOptions = computeOrderingOptions(occupants, ownerId);

  return (
    <div
      data-testid="addressee-rail"
      style={{
        position: "absolute",
        pointerEvents: "auto",
        top: 64,
        left: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 10,
      }}
    >
      {occupants.map((id) => {
        const selected = addressee.kind === "agent" ? addressee.id === id : addressee.kind === "none" && activeSpeakerId === id;
        return (
          <button
            key={id}
            type="button"
            data-testid={`addressee-${id}`}
            onClick={() => onSelect(id)}
            style={{
              borderRadius: 6,
              border: `2px solid ${selected ? CASTLE.cream : CASTLE.creamFaint}`,
              background: selected ? CASTLE.hover : CASTLE.bgTranslucent,
              color: CASTLE.cream,
              fontSize: 14,
              padding: "6px 14px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {id === ownerId ? `${cap(id)} (owner)` : cap(id)}
          </button>
        );
      })}
      {orderingOptions.map((order, idx) => {
        const selected = addressee.kind === "order" && addressee.order.join(",") === order.join(",");
        const label = order.map(cap).join("-");
        return (
          <button
            key={order.join("-")}
            type="button"
            data-testid={`addressee-order-${idx}`}
            onClick={() => onSelectOrder(order)}
            style={{
              marginTop: idx === 0 ? 8 : 0,
              borderRadius: 6,
              border: `2px solid ${selected ? CASTLE.cream : CASTLE.creamFaint}`,
              background: selected ? CASTLE.hover : CASTLE.bgTranslucent,
              color: CASTLE.cream,
              fontSize: 14,
              padding: "6px 14px",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
