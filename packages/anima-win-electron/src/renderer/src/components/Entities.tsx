import { useEffect, useState } from "react";
import type { ApiClient, ColonyAgent } from "../lib/api";
import type { PollStatus } from "../lib/poller";

interface Props {
  api: ApiClient;
  status: PollStatus | null;
  epoch: number;
}

function avgTrust(agent: ColonyAgent): number | null {
  const domains = agent.trust?.domains;
  if (!domains || domains.length === 0) return null;
  return domains.reduce((s, d) => s + d.score, 0) / domains.length;
}

export function Entities({ api, status, epoch }: Props) {
  const [agents, setAgents] = useState<ColonyAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ColonyAgent | null>(null);
  const [detail, setDetail] = useState<ColonyAgent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getColony()
      .then((c) => !cancelled && setAgents(c.agents))
      .catch((e) => !cancelled && (setAgents(null), setError(String(e.message ?? e))));
    return () => {
      cancelled = true;
    };
  }, [api, status, epoch]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getAgent(selected.name)
      .then((a) => !cancelled && setDetail(a))
      .catch(() => !cancelled && setDetail(selected)); // fall back to list data
    return () => {
      cancelled = true;
    };
  }, [api, selected]);

  const shown = detail ?? selected;

  return (
    <div className="flex h-full">
      {/* Grid */}
      <div className="h-full flex-1 overflow-y-auto p-6">
        {error && (
          <div
            className="mb-4 rounded-lg border px-4 py-3 text-sm"
            style={{ borderColor: "var(--bad)", color: "var(--bad)", background: "var(--panel)" }}
          >
            Backend unreachable: {error}
          </div>
        )}
        {!agents && !error && (
          <div className="flex justify-center py-16">
            <div className="spinner" />
          </div>
        )}
        {agents && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {agents.map((a) => {
              const trust = avgTrust(a);
              const active = selected?.name === a.name;
              return (
                <button
                  key={a.name}
                  onClick={() => setSelected(active ? null : a)}
                  className="cursor-pointer rounded-xl border p-4 text-left transition-colors"
                  style={{
                    background: active ? "var(--accent-dim)" : "var(--panel)",
                    borderColor: active ? "var(--accent)" : "var(--border)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                      {a.name}
                    </span>
                    {a.platform && (
                      <span
                        className="rounded-full border px-2 py-0.5 text-[10px] uppercase"
                        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                      >
                        {a.platform}
                      </span>
                    )}
                  </div>
                  {a.substrateName && (
                    <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                      {a.substrateName}
                    </div>
                  )}
                  {trust !== null && (
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[10px]" style={{ color: "var(--muted)" }}>
                        <span>trust</span>
                        <span>{(trust * 100).toFixed(0)}%</span>
                      </div>
                      <div className="h-1 w-full rounded-full" style={{ background: "var(--panel-2)" }}>
                        <div
                          className="h-1 rounded-full"
                          style={{ width: `${trust * 100}%`, background: "var(--accent)" }}
                        />
                      </div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {shown && (
        <aside
          className="h-full w-80 overflow-y-auto border-l p-5"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold" style={{ color: "var(--accent)" }}>
              {shown.name}
            </h2>
            <button
              onClick={() => setSelected(null)}
              className="cursor-pointer text-sm"
              style={{ color: "var(--muted)" }}
            >
              ✕
            </button>
          </div>
          <dl className="space-y-3 text-sm">
            {(
              [
                ["Substrate", shown.substrateName],
                ["Path", shown.substratePath],
                ["Platform", shown.platform],
                ["Squad", shown.squad],
                ["Continuity", shown.continuityMode],
              ] as Array<[string, unknown]>
            )
              .filter(([, v]) => v != null && v !== "")
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                    {k}
                  </dt>
                  <dd className="mt-0.5 break-all">{String(v)}</dd>
                </div>
              ))}
            {shown.trust?.domains && shown.trust.domains.length > 0 && (
              <div>
                <dt className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  Trust domains
                </dt>
                <dd className="mt-1 space-y-1">
                  {shown.trust.domains.map((d) => (
                    <div key={d.domain} className="flex justify-between text-xs">
                      <span>{d.domain}</span>
                      <span style={{ color: "var(--muted)" }}>
                        {(d.score * 100).toFixed(0)}% · {d.samples} samples
                      </span>
                    </div>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </aside>
      )}
    </div>
  );
}
