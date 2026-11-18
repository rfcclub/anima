export type ConnStatus = "connected" | "reconnecting" | "disconnected";

const META: Record<ConnStatus, { color: string; label: string }> = {
  connected: { color: "var(--ok)", label: "Connected" },
  reconnecting: { color: "var(--warn)", label: "Reconnecting" },
  disconnected: { color: "var(--bad)", label: "Disconnected" },
};

interface Props {
  status: ConnStatus;
  profileName: string;
  onRefresh: () => void;
}

export function StatusPill({ status, profileName, onRefresh }: Props) {
  const m = META[status];
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
        style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            background: m.color,
            boxShadow: status === "connected" ? `0 0 6px ${m.color}` : undefined,
          }}
        />
        <span style={{ color: "var(--text)" }}>{m.label}</span>
        <span style={{ color: "var(--muted)" }}>· {profileName}</span>
      </div>
      <button
        onClick={onRefresh}
        title="Reload all views"
        className="cursor-pointer rounded-full border px-2.5 py-1 text-xs"
        style={{
          borderColor: "var(--border)",
          background: "var(--panel-2)",
          color: "var(--muted)",
        }}
      >
        ⟳
      </button>
    </div>
  );
}
