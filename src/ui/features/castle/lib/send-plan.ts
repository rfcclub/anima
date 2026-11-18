import type { Addressee } from "./addressee-selection";

/** Who the server will run beats for after a send, in speaking order: the same choice talk.ts makes, from what
 *  the room knows when the message goes out. `fallbackSpeakerId` is the single speaker when nothing is chosen. */
export function expectedSpeakers(a: Addressee, ownerId: string, occupants: string[], fallbackSpeakerId: string): string[] {
  if (a.kind === "order") return a.order.slice(0, 3);
  if (a.kind === "all") {
    const guest = occupants.find((id) => id !== ownerId);
    return occupants.includes(ownerId) && guest ? [ownerId, guest] : [fallbackSpeakerId];
  }
  if (a.kind === "agent") return [a.id];
  return [fallbackSpeakerId];
}
