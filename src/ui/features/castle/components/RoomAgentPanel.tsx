/**
 * Left panel framing the owner agent's portrait. The agent name sits at the
 * TOP of the panel, above the portrait; the portrait occupies roughly the
 * top half of the screen (not full height). Matches the reference layout.
 */
export function RoomAgentPanel({ agentName }: { agentName: string }) {
  return (
    <div
      data-testid="room-agent-panel"
      className="absolute pointer-events-none flex flex-col items-center pt-6 bg-castle-bg border-r-2 border-castle-cream-faint z-0"
      style={{ top: 0, bottom: 0, left: 0, width: "22%" }}
    >
      <div
        className="text-castle-cream tracking-[3px] font-bold text-center mb-4"
        style={{ fontSize: 22 }}
      >
        {agentName}
      </div>
    </div>
  );
}
