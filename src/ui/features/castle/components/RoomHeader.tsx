/** Agent name, top-right of the room screen (over the scene, not the
 *  left transcript sidebar). */
export function RoomHeader({ agentName }: { agentName: string }) {
  return (
    <div
      data-testid="room-header"
      className="absolute top-4 text-castle-cream tracking-[3px] font-bold pointer-events-none text-right"
      style={{ fontSize: 28, right: 376 }}
    >
      {agentName}
    </div>
  );
}
