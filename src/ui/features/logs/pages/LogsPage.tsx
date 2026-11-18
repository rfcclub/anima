import { useState, useEffect, useRef, useCallback } from "react";

interface LogEntry {
  level?: string;
  ts?: string;
  msg?: string;
  [k: string]: unknown;
}

function levelClass(lvl?: string): string {
  if (lvl === "error") return "border-l-red-800 bg-red-950/40 hover:bg-red-950/60";
  if (lvl === "warn") return "border-l-yellow-700 bg-yellow-950/30";
  return "border-l-indigo-900/60";
}

function levelLabelClass(lvl?: string): string {
  if (lvl === "error") return "text-red-400";
  if (lvl === "warn") return "text-yellow-600";
  return "text-indigo-400";
}

function extraFields(e: LogEntry): string | null {
  const skip = new Set(["level", "ts", "msg"]);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!skip.has(k)) rest[k] = v;
  }
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null;
}

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [levelSel, setLevelSel] = useState("");
  const [live, setLive] = useState(false);
  const [sub, setSub] = useState("loading…");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const esRef = useRef<EventSource | null>(null);

  const loadInitial = useCallback(async () => {
    setSub("loading…");
    setEntries([]);
    try {
      const r = await fetch("/api/logs?lines=200");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = (await r.json()) as LogEntry[];
      setEntries(data);
      setSub(data.length + " entries · " + new Date().toLocaleTimeString());
    } catch (err) {
      setSub("error");
      setEntries([{ level: "error", msg: "error loading logs: " + err }]);
    }
  }, []);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  const toggleLive = useCallback((on: boolean) => {
    setLive(on);
    if (on) {
      const es = new EventSource("/api/logs/stream");
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as LogEntry;
          setEntries((prev) => [e, ...prev]);
        } catch { /* ignore */ }
      };
      es.onerror = () => setLive(false);
      esRef.current = es;
    } else {
      esRef.current?.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  const filtered = entries.filter((e) => {
    const json = JSON.stringify(e).toLowerCase();
    const lvlOk = !levelSel || json.includes('"level":"' + levelSel + '"');
    const qOk = !filter || json.includes(filter.toLowerCase());
    return lvlOk && qOk;
  });

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  return (
    <div className="min-h-screen p-6 bg-[#0f0f13] text-[#c8c8d4]" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
      <h1 className="text-[1.1rem] text-[#a0a0f0] mb-0.5 tracking-wider">ANIMA — Logs</h1>
      <div className="text-[#55556a] text-[0.72rem] mb-5">{sub}</div>

      <div className="flex gap-2.5 items-center mb-4 flex-wrap">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-[180px] bg-[#1a1a28] border border-[#2e2e48] rounded text-[#c8c8d4] px-2.5 py-1.5 text-[0.78rem] outline-none focus:border-[#5050a0] transition-colors"
        />
        <select
          value={levelSel}
          onChange={(e) => setLevelSel(e.target.value)}
          className="bg-[#1a1a28] border border-[#2e2e48] rounded text-[#c8c8d4] px-2 py-1.5 text-[0.78rem] outline-none cursor-pointer"
        >
          <option value="">all levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button onClick={loadInitial} className="bg-[#1a1a28] border border-[#2e2e48] rounded text-[#888] px-2.5 py-1.5 text-[0.72rem] cursor-pointer hover:border-[#5050a0] hover:text-[#a0a0f0] transition-all">reload</button>
        <label className="flex items-center gap-1.5 text-[0.75rem] text-[#666] cursor-pointer select-none">
          <input type="checkbox" checked={live} onChange={(e) => toggleLive(e.target.checked)} className="cursor-pointer accent-[#5050d0]" />
          live&nbsp;<span className={`w-[7px] h-[7px] rounded-full inline-block transition ${live ? "bg-[#44d444] shadow-[0_0_5px_#44d444]" : "bg-[#333]"}`} />
        </label>
        <span className="text-[0.68rem] text-[#55556a] ml-auto whitespace-nowrap">{filtered.length} visible</span>
      </div>

      <div className="flex flex-col gap-px">
        {filtered.length === 0 ? (
          <div className="text-[#44445a] text-[0.8rem] py-4">no log entries</div>
        ) : filtered.map((e, i) => {
          const extra = extraFields(e);
          const isExpanded = expanded.has(i);
          return (
            <div
              key={i}
              onClick={extra ? () => toggleExpand(i) : undefined}
              className={`px-2 py-1 rounded text-[0.72rem] leading-[1.6] border-l-[3px] hover:bg-[#16161f] transition-colors ${levelClass(e.level)} ${extra ? "cursor-pointer" : ""}`}
            >
              <div className="flex gap-2 items-baseline flex-nowrap">
                <span className="text-[#44445a] text-[0.67rem] min-w-[152px] flex-shrink-0">{String(e.ts ?? "").slice(0, 19).replace("T", " ")}</span>
                <span className={`text-[0.67rem] font-bold min-w-[38px] uppercase flex-shrink-0 ${levelLabelClass(e.level)}`}>{e.level ?? ""}</span>
                <span className="flex-1 text-[#c0c0cc] break-all whitespace-pre-wrap">{String(e.msg ?? "")}</span>
              </div>
              {extra && isExpanded && (
                <div className="mt-1.5 px-2 py-1.5 bg-[#0c0c14] rounded text-[0.67rem] text-[#666] whitespace-pre-wrap break-all border border-[#1e1e30]">{extra}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
