import type { PollStatus } from "../lib/poller";

interface Props {
  status: PollStatus | null;
  apiUrl: string;
}

export function StatusPill({ status, apiUrl }: Props) {
  const connected = status === "connected";
  const color = status === null ? "var(--muted)" : connected ? "var(--ok)" : "var(--bad)";
  const label = status === null ? "Checking…" : connected ? "Connected" : "Disconnected";
  return (
    <div
      className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color, boxShadow: connected ? `0 0 6px ${color}` : undefined }}
      />
      <span style={{ color: "var(--text)" }}>{label}</span>
      <span style={{ color: "var(--muted)" }}>· {apiUrl}</span>
    </div>
  );
}
