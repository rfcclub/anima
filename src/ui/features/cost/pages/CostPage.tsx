import { useState, useEffect, useCallback } from "react";
import { describeEstimate, describeLegacy, type EstimateCoverage, type LegacyBlock } from "../lib/estimate";

// ── formatting helpers (ported verbatim from cost.html) ──

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number(n).toFixed(dec);
}

function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(4);
}

function hitRate(read: number, total: number): number {
  return total > 0 ? Math.round((read || 0) / total * 100) : 0;
}

const PROVIDER_BADGES: Record<string, string> = {
  claude: "bg-blue-900/40 text-blue-400",
  exampleprov: "bg-green-900/40 text-green-400",
  minimax: "bg-purple-900/40 text-purple-400",
  xiaomi: "bg-red-900/40 text-red-400",
  gemini: "bg-blue-900/40 text-blue-400",
  openai: "bg-green-900/40 text-green-400",
  fireworks: "bg-orange-900/40 text-orange-400",
};

function badgeClass(provider: string): string {
  return PROVIDER_BADGES[provider] ?? "bg-neutral-800 text-neutral-400";
}

// ── types ──

interface ProviderRow { provider: string; requestCount: number; totalInputTokens: number; totalOutputTokens: number; cacheReadTokens: number; }
interface ModelRow { model: string; provider: string; requestCount: number; totalInputTokens: number; totalOutputTokens: number; cacheReadTokens: number; }
interface AgentRow { agentId: string; requestCount: number; totalInputTokens: number; totalOutputTokens: number; totalTokens: number; }

interface CostData {
  summary?: EstimateCoverage & {
    estimatedCost: number; totalRequests: number; totalInputTokens: number; totalOutputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number;
  };
  /** Rows written before call records existed, reported apart and as stored. */
  legacy?: LegacyBlock;
  byProvider?: ProviderRow[];
  byModel?: ModelRow[];
  byAgent?: AgentRow[];
  message?: string;
}

type SortDir = 1 | -1;
interface SortState { key: string; dir: SortDir; }

// ── component ──

export function CostPage() {
  const [since, setSince] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [until, setUntil] = useState("");
  const [agent, setAgent] = useState("");
  const [data, setData] = useState<CostData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState("Loading...");

  const [providerSort, setProviderSort] = useState<SortState>({ key: "totalInputTokens", dir: -1 });
  const [modelSort, setModelSort] = useState<SortState>({ key: "totalInputTokens", dir: -1 });
  const [agentSort, setAgentSort] = useState<SortState>({ key: "totalTokens", dir: -1 });

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (agent.trim()) params.set("agent", agent.trim());
    setError(null);
    try {
      const res = await fetch("/api/cost?" + params);
      const d = await res.json() as CostData;
      setData(d);
      setLastUpdated("Updated " + new Date().toLocaleTimeString());
    } catch (e) {
      setError("Failed to load: " + (e as Error).message);
    }
  }, [since, until, agent]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  function toggleSort(current: SortState, key: string, type: "provider" | "model" | "agent"): SortState {
    if (current.key === key) return { key, dir: (current.dir * -1) as SortDir };
    const dir: SortDir = ["provider", "model", "agentId"].includes(key) ? 1 : -1;
    return { key, dir };
  }

  function sortRows(rows: Array<Record<string, any>>, state: SortState, type: "provider" | "model" | "agent"): Array<Record<string, any>> {
    const getVal = (r: Record<string, any>): string | number => {
      if (state.key === "hitRate") return hitRate((r.cacheReadTokens as number) || 0, (r.totalInputTokens as number) || 0);
      if (state.key === "usage" && type === "provider") return (r.totalInputTokens as number) || 0;
      if (state.key === "usage" && type === "agent") return (r.totalTokens as number) || 0;
      return (r[state.key] as string | number) || 0;
    };
    return [...rows].sort((a, b) => {
      const av = getVal(a); const bv = getVal(b);
      if (typeof av === "string" || typeof bv === "string") return (av < bv ? -1 : av > bv ? 1 : 0) * state.dir;
      return ((av as number) - (bv as number)) * state.dir;
    });
  }

  function SortHeader({ label, sortKey, state, type, setSort }: {
    label: string; sortKey: string; state: SortState; type: "provider" | "model" | "agent";
    setSort: (s: SortState) => void;
  }) {
    const active = state.key === sortKey;
    const arrow = active ? (state.dir === -1 ? "▼" : "▲") : "";
    return (
      <th
        className="text-left text-neutral-400 font-medium px-2.5 py-1.5 border-b border-neutral-700 text-[11px] uppercase tracking-wider cursor-pointer hover:text-neutral-200 select-none"
        onClick={() => setSort(toggleSort(state, sortKey, type))}
      >
        {label}<span className="ml-1 text-amber-500 text-[10px] w-2 inline-block">{arrow}</span>
      </th>
    );
  }

  const s = data?.summary;
  const cacheTokens = (s?.cacheReadTokens ?? 0);
  const totalIn = s?.totalInputTokens ?? 1;
  const cachePct = totalIn > 0 ? Math.round(cacheTokens / totalIn * 100) : 0;

  const providers = data?.byProvider ?? [];
  const models = data?.byModel ?? [];
  const agents = data?.byAgent ?? [];
  const maxIn = Math.max(1, ...providers.map(r => r.totalInputTokens || 0));
  const maxA = Math.max(1, ...agents.map(r => r.totalTokens || 0));

  return (
    <div className="min-h-screen p-5 bg-neutral-950 text-neutral-100 text-[13px]" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace" }}>
      <h1 className="text-amber-500 text-[18px] font-semibold tracking-wider mb-1">⚡ ANIMA Cost Dashboard</h1>
      <div className="text-neutral-400 text-[11px] mb-5">{lastUpdated}</div>

      <div className="flex gap-2.5 items-center mb-5 flex-wrap">
        <label className="text-neutral-400 text-[11px]">Since</label>
        <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="bg-neutral-800 border border-neutral-700 text-neutral-100 px-2.5 py-1 rounded-md text-xs focus:outline-none focus:border-amber-500" />
        <label className="text-neutral-400 text-[11px]">Until</label>
        <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="bg-neutral-800 border border-neutral-700 text-neutral-100 px-2.5 py-1 rounded-md text-xs focus:outline-none focus:border-amber-500" />
        <label className="text-neutral-400 text-[11px]">Agent</label>
        <input type="text" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="all" className="w-[100px] bg-neutral-800 border border-neutral-700 text-neutral-100 px-2.5 py-1 rounded-md text-xs focus:outline-none focus:border-amber-500" />
        <button onClick={load} className="bg-amber-500 text-neutral-950 border-none px-3.5 py-1 rounded-md text-xs font-semibold cursor-pointer hover:bg-amber-400">Refresh</button>
      </div>

      {error && (
        <div className="text-red-400 p-3 bg-red-500/10 border border-red-500/30 rounded-md mb-4">{error}</div>
      )}

      {data?.message && !s && (
        <div className="text-neutral-400 italic px-2.5 py-4">{data.message}</div>
      )}

      {s && (
        <>
          <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3.5">
              <div className="text-neutral-400 text-[10px] uppercase tracking-wider mb-1.5">Total Cost</div>
              <div className="text-[22px] font-bold text-amber-500">{fmtCost(s.estimatedCost)}</div>
              <div className="text-neutral-400 text-[10px] mt-0.5">{fmt(s.totalRequests, 0)} requests</div>
              {describeEstimate(s) && <div className="text-amber-500 text-[10px] mt-0.5">{describeEstimate(s)}</div>}
              {describeLegacy(data?.legacy) && <div className="text-neutral-400 text-[10px] mt-0.5">{describeLegacy(data?.legacy)}</div>}
            </div>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3.5">
              <div className="text-neutral-400 text-[10px] uppercase tracking-wider mb-1.5">Input Tokens</div>
              <div className="text-[16px] font-bold text-blue-400">{fmt(s.totalInputTokens)}</div>
              <div className="text-neutral-400 text-[10px] mt-0.5">{fmt(s.totalOutputTokens)} output</div>
            </div>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3.5">
              <div className="text-neutral-400 text-[10px] uppercase tracking-wider mb-1.5">Cache Hit Rate</div>
              <div className="text-[22px] font-bold text-green-400">{cachePct}%</div>
              <div className="text-neutral-400 text-[10px] mt-0.5">of input tokens</div>
            </div>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3.5">
              <div className="text-neutral-400 text-[10px] uppercase tracking-wider mb-1.5">Cache Hits</div>
              <div className="text-[22px] font-bold text-neutral-100">{fmt(s.cacheReadTokens)}</div>
              <div className="text-neutral-400 text-[10px] mt-0.5">tokens read</div>
            </div>
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-3.5">
              <div className="text-neutral-400 text-[10px] uppercase tracking-wider mb-1.5">Cache Writes</div>
              <div className="text-[22px] font-bold text-neutral-100">{fmt(s.cacheWriteTokens)}</div>
              <div className="text-neutral-400 text-[10px] mt-0.5">tokens stored</div>
            </div>
          </div>

          <div className="mb-6">
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 mb-2.5 pb-1.5 border-b border-neutral-700">By Provider</div>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <SortHeader label="Provider" sortKey="provider" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Requests" sortKey="requestCount" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Input" sortKey="totalInputTokens" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Output" sortKey="totalOutputTokens" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Cache Hits" sortKey="cacheReadTokens" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Hit Rate" sortKey="hitRate" state={providerSort} type="provider" setSort={setProviderSort} />
                  <SortHeader label="Usage" sortKey="usage" state={providerSort} type="provider" setSort={setProviderSort} />
                </tr>
              </thead>
              <tbody>
                {providers.length === 0 ? (
                  <tr><td className="text-neutral-400 italic px-2.5 py-4">No data</td></tr>
                ) : sortRows(providers, providerSort, "provider").map((r, i) => (
                  <tr key={i} className="border-b border-neutral-800/50">
                    <td className="px-2.5 py-1.5"><span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeClass(r.provider)}`}>{r.provider}</span></td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.requestCount, 0)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalInputTokens)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalOutputTokens)}</td>
                    <td className="text-right tabular-nums text-green-400 px-2.5 py-1.5">{fmt(r.cacheReadTokens)}</td>
                    <td className="text-right tabular-nums text-green-400 px-2.5 py-1.5">{hitRate(r.cacheReadTokens, r.totalInputTokens)}%</td>
                    <td className="px-2.5 py-1.5"><div className="flex items-center gap-2"><div className="h-1 rounded bg-amber-500 transition-all" style={{ width: Math.round((r.totalInputTokens || 0) / maxIn * 120) + "px", minWidth: "2px" }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mb-6">
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 mb-2.5 pb-1.5 border-b border-neutral-700">By Model</div>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <SortHeader label="Model" sortKey="model" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Provider" sortKey="provider" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Requests" sortKey="requestCount" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Input" sortKey="totalInputTokens" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Output" sortKey="totalOutputTokens" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Cache Hits" sortKey="cacheReadTokens" state={modelSort} type="model" setSort={setModelSort} />
                  <SortHeader label="Hit Rate" sortKey="hitRate" state={modelSort} type="model" setSort={setModelSort} />
                </tr>
              </thead>
              <tbody>
                {models.length === 0 ? (
                  <tr><td className="text-neutral-400 italic px-2.5 py-4">No data</td></tr>
                ) : sortRows(models, modelSort, "model").map((r, i) => (
                  <tr key={i} className="border-b border-neutral-800/50">
                    <td className="font-mono text-[11px] px-2.5 py-1.5">{r.model}</td>
                    <td className="px-2.5 py-1.5"><span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeClass(r.provider)}`}>{r.provider}</span></td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.requestCount, 0)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalInputTokens)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalOutputTokens)}</td>
                    <td className="text-right tabular-nums text-green-400 px-2.5 py-1.5">{fmt(r.cacheReadTokens)}</td>
                    <td className="text-right tabular-nums text-green-400 px-2.5 py-1.5">{hitRate(r.cacheReadTokens, r.totalInputTokens)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mb-6">
            <div className="text-[12px] uppercase tracking-wider text-neutral-400 mb-2.5 pb-1.5 border-b border-neutral-700">By Agent</div>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <SortHeader label="Agent" sortKey="agentId" state={agentSort} type="agent" setSort={setAgentSort} />
                  <SortHeader label="Requests" sortKey="requestCount" state={agentSort} type="agent" setSort={setAgentSort} />
                  <SortHeader label="Input" sortKey="totalInputTokens" state={agentSort} type="agent" setSort={setAgentSort} />
                  <SortHeader label="Output" sortKey="totalOutputTokens" state={agentSort} type="agent" setSort={setAgentSort} />
                  <SortHeader label="Usage" sortKey="usage" state={agentSort} type="agent" setSort={setAgentSort} />
                </tr>
              </thead>
              <tbody>
                {agents.length === 0 ? (
                  <tr><td className="text-neutral-400 italic px-2.5 py-4">No data</td></tr>
                ) : sortRows(agents, agentSort, "agent").map((r, i) => (
                  <tr key={i} className="border-b border-neutral-800/50">
                    <td className="font-semibold px-2.5 py-1.5">{r.agentId}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.requestCount, 0)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalInputTokens)}</td>
                    <td className="text-right tabular-nums px-2.5 py-1.5">{fmt(r.totalOutputTokens)}</td>
                    <td className="px-2.5 py-1.5"><div className="flex items-center gap-2"><div className="h-1 rounded bg-amber-500 transition-all" style={{ width: Math.round((r.totalTokens || 0) / maxA * 120) + "px", minWidth: "2px" }} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
