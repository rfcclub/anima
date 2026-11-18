import { useEffect, useState } from "react";
import type { ApiClient, HealthResponse } from "../lib/api";
import type { PollStatus } from "../lib/poller";

interface Props {
  api: ApiClient;
  status: PollStatus | null;
  /** Bumped whenever the poll target changes so we refetch. */
  epoch: number;
}

export function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ background: "var(--panel)", borderColor: "var(--border)" }}
    >
      <div className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold" style={{ color: "var(--accent)" }}>
        {value}
      </div>
    </div>
  );
}

export function Overview({ api, status, epoch }: Props) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getHealth()
      .then((h) => !cancelled && setHealth(h))
      .catch((e) => !cancelled && (setHealth(null), setError(String(e.message ?? e))));
    return () => {
      cancelled = true;
    };
  }, [api, status, epoch]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-xl font-semibold">Welcome to ANIMA</h1>
        <p className="mb-6 text-sm" style={{ color: "var(--muted)" }}>
          Native desktop client — live view of the colony backend.
        </p>

        {error && (
          <div
            className="mb-4 rounded-lg border px-4 py-3 text-sm"
            style={{ borderColor: "var(--bad)", color: "var(--bad)", background: "var(--panel)" }}
          >
            Backend unreachable: {error}
          </div>
        )}

        {health ? (
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Uptime" value={formatUptime(health.uptime)} />
            <Stat label="Agents" value={String(health.agents.length)} />
            <Stat label="Version" value={health.version} />
          </div>
        ) : (
          !error && (
            <div className="flex justify-center py-16">
              <div className="spinner" />
            </div>
          )
        )}

        {health && (
          <div
            className="mt-4 rounded-xl border p-5"
            style={{ background: "var(--panel)", borderColor: "var(--border)" }}
          >
            <div className="mb-3 text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Colony roster
            </div>
            <div className="flex flex-wrap gap-2">
              {health.agents.map((a) => (
                <span
                  key={a}
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--panel-2)",
                    color: "var(--text)",
                  }}
                >
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
