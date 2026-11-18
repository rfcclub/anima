import { useState, useEffect } from "react";

interface Branch { id: string; name: string; agent: string; parentBranchId?: string | null; isActive?: boolean; forkFromTurnId?: string | number; }
interface Choice { label: string; value?: string; timestamp?: string; agent: string; }
interface AgentData { branches?: Branch[]; choices?: Choice[]; narrativeState?: string | Record<string, unknown>; }
type DataMap = Record<string, AgentData>;

export function NarrativePage() {
  const [agents, setAgents] = useState<string[]>([]);
  const [data, setData] = useState<DataMap>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/colony/states");
        if (!r.ok) throw new Error("colony not available");
        const states = await r.json() as Array<{ agent?: string; name?: string; agentId?: string }>;
        const names = (states || []).map((s) => s.agent || s.name || s.agentId).filter(Boolean) as string[];
        setAgents(names);
        const d: DataMap = {};
        for (const agent of names) {
          try {
            const cr = await fetch("/api/vn/choices/" + agent);
            if (cr.ok) d[agent] = await cr.json() as AgentData;
          } catch { /* ignore */ }
        }
        setData(d);
      } catch {
        setError("Could not load narrative data. Is ANIMA running?");
      }
    })();
  }, []);

  const allBranches: Branch[] = [];
  const allChoices: Choice[] = [];
  const allFlags: Record<string, unknown> = {};
  const allThreads: Array<{ from: string; to: string; via: string }> = [];

  for (const [agent, d] of Object.entries(data)) {
    (d.branches || []).forEach((b) => allBranches.push({ ...b, agent }));
    (d.choices || []).forEach((c) => allChoices.push({ ...c, agent }));
    if (d.narrativeState) {
      try {
        const ns = typeof d.narrativeState === "string" ? JSON.parse(d.narrativeState) : d.narrativeState;
        const rec = ns as { flags?: Record<string, unknown>; counters?: Record<string, unknown> };
        if (rec.flags) Object.assign(allFlags, rec.flags);
        if (rec.counters) Object.entries(rec.counters).forEach(([k, v]) => { allFlags["#" + k] = v; });
      } catch { /* ignore */ }
    }
  }
  for (const [agent, d] of Object.entries(data)) {
    (d.choices || []).forEach((c) => {
      agents.forEach((other) => {
        if (other !== agent && (c.label + " " + (c.value || "")).toLowerCase().includes(other)) {
          allThreads.push({ from: agent, to: other, via: c.label });
        }
      });
    });
  }

  const byAgent: Record<string, Branch[]> = {};
  allBranches.forEach((b) => { if (!byAgent[b.agent]) byAgent[b.agent] = []; byAgent[b.agent].push(b); });

  const sortedChoices = [...allChoices].sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  const uniqueThreads: Array<{ from: string; to: string; via: string }> = [];
  const seen = new Set<string>();
  allThreads.forEach((t) => {
    const k = t.from + "->" + t.to;
    if (!seen.has(k)) { seen.add(k); uniqueThreads.push(t); }
  });

  if (error) {
    return (
      <div className="min-h-screen bg-[#1a1208] text-[#d4c09a] p-6" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#1a1208] text-[#d4c09a] p-6" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl text-[#e4c76b] font-semibold">📖 Narrative Hub</h1>
        <a href="/" className="text-[11px] text-[#7a5c30] hover:text-[#e4c76b]">◂ Town</a>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-3" style={{ gridColumn: "1 / -1" }}>
          <h3 className="text-[#e4c76b] text-sm mb-2">🌿 Branch Tree</h3>
          {allBranches.length === 0 ? (
            <div className="text-[#6a5e48] text-sm">No narrative branches yet. Make choices in VN Stage to create branches.</div>
          ) : (
            <div>
              {Object.entries(byAgent).map(([agent, abs]) => (
                <div key={agent}>
                  <div className="text-[12px] text-[#e4c76b] my-2 tracking-wide">{agent.charAt(0).toUpperCase() + agent.slice(1)}</div>
                  {abs.filter((b) => !b.parentBranchId).map((root) => (
                    <div key={root.id}>
                      <div className={`flex items-center gap-2 py-1 px-2 rounded ${root.isActive ? "bg-[#3a2e1e] text-[#e4c76b]" : ""}`}>
                        <span>{root.isActive ? "▸" : "🌿"}</span>
                        <span className="text-[12px]">{root.name}</span>
                        <span className="text-[10px] text-[#6a5e48]">root</span>
                        {root.isActive && <span className="text-[10px] px-1 rounded bg-[#c9a84c] text-[#1a1208]">active</span>}
                      </div>
                      {abs.filter((c) => c.parentBranchId === root.id).map((sub) => (
                        <div key={sub.id} className={`flex items-center gap-2 py-1 px-2 ml-4 rounded ${sub.isActive ? "bg-[#3a2e1e] text-[#e4c76b]" : ""}`}>
                          <span>{sub.isActive ? "▸" : "↳"}</span>
                          <span className="text-[12px]">{sub.name}</span>
                          <span className="text-[10px] text-[#6a5e48]">fork@{sub.forkFromTurnId ?? "?"}</span>
                          {sub.isActive && <span className="text-[10px] px-1 rounded bg-[#c9a84c] text-[#1a1208]">active</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-3">
          <h3 className="text-[#e4c76b] text-sm mb-2">📋 Choice Timeline</h3>
          {sortedChoices.length === 0 ? (
            <div className="text-[#6a5e48] text-sm">No choices recorded yet.</div>
          ) : (
            <div className="flex flex-col gap-1 max-h-96 overflow-y-auto">
              {sortedChoices.slice(0, 50).map((c, i) => (
                <div key={i} className="flex gap-2 text-[11px] py-1 border-b border-[#3a2e1e]/50">
                  <span className="text-[#6a5e48] min-w-[120px]" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.timestamp ? new Date(c.timestamp).toLocaleString() : ""}</span>
                  <span className="text-[#d4c09a]">{c.label}</span>
                  <span className="text-[#6a5e48]">{c.value || ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-3">
          <h3 className="text-[#e4c76b] text-sm mb-2">🚩 Story Flags</h3>
          {Object.keys(allFlags).length === 0 ? (
            <div className="text-[#6a5e48] text-sm">No story flags set. Make choices to create them.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {Object.entries(allFlags).map(([k, v]) => (
                <div key={k} className="flex gap-2 text-[11px] py-1">
                  <span className="text-[#c9a84c]">{k}</span>
                  <span className="text-[#d4c09a]">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-3" style={{ gridColumn: "1 / -1" }}>
          <h3 className="text-[#e4c76b] text-sm mb-2">🔗 Cross-Agent Threads</h3>
          {uniqueThreads.length === 0 ? (
            <div className="text-[#6a5e48] text-sm">No cross-agent references detected yet.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {uniqueThreads.map((t, i) => (
                <div key={i} className="flex gap-2 text-[11px] py-1">
                  <span className="text-[#c9a84c]">{t.from}</span>
                  <span className="text-[#6a5e48]">→</span>
                  <span className="text-[#c9a84c]">{t.to}</span>
                  <span className="text-[#d4c09a]">{t.via}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
