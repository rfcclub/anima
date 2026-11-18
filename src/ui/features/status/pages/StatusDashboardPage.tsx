import { useState, useEffect, useMemo, useCallback } from "react";
import type { ProjectSnapshot, ChangeRecord, LifecycleState } from "../../../../status/scanner";

/**
 * Project status dashboard — dense, operational view of OpenSpec/LoomKit changes.
 *
 * Renders a snapshot either passed in (SSR/test) or fetched from /api/projects
 * (SPA). Reads-only; no mutation.
 */
export function StatusDashboardPage({ snapshot: initial }: { snapshot?: ProjectSnapshot }) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleState | "all">("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnapshot(await res.json());
    } catch (e) {
      setError("Failed to load: " + (e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!initial) load();
  }, [initial, load]);

  const changes = useMemo(() => {
    if (!snapshot) return [];
    const base = filter === "active" ? snapshot.activeChanges : snapshot.archivedChanges;
    return base.filter((c) => {
      if (lifecycleFilter !== "all" && c.lifecycle !== lifecycleFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.title.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [snapshot, filter, lifecycleFilter, search]);

  if (error) {
    return <div className="p-6 text-red-400" data-testid="status-error">{error}</div>;
  }
  if (!snapshot) {
    return <div className="p-6 text-neutral-400">Loading project status…</div>;
  }

  const grouped = groupByLifecycle(changes);

  return (
    <div className="min-h-screen bg-[#1a1410] text-[#e8d8b0] p-6" data-testid="status-dashboard">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-wide">Project Status</h1>
        <p className="text-sm text-[#8a7a5f] mt-1">
          Generated {new Date(snapshot.generatedAt).toLocaleString()} · {snapshot.root}
        </p>
      </header>

      <SummaryBand summary={snapshot.summary} />

      <div className="flex flex-wrap gap-2 my-4 items-center">
        <FilterGroup
          label="View"
          value={filter}
          options={[["active", "Active"], ["archived", "Archived"]]}
          onChange={(v) => setFilter(v as "active" | "archived")}
        />
        <FilterGroup
          label="Lifecycle"
          value={lifecycleFilter}
          options={[
            ["all", "All"],
            ["draft", "Draft"],
            ["planned", "Planned"],
            ["in_progress", "In Progress"],
            ["review", "Review"],
            ["verified", "Verified"],
            ["archived", "Archived"],
          ]}
          onChange={(v) => setLifecycleFilter(v as LifecycleState | "all")}
        />
        <input
          type="text"
          placeholder="Search changes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-[#241c14] border border-[#e8d8b055] rounded px-3 py-1 text-sm text-[#e8d8b0] placeholder-[#8a7a5f] focus:outline-none focus:border-[#e8d8b0]"
        />
        <button
          type="button"
          onClick={load}
          className="text-sm px-3 py-1 rounded border border-[#e8d8b055] hover:bg-[#2a2015] cursor-pointer"
        >
          ↻ Refresh
        </button>
      </div>

      {changes.length === 0 ? (
        <div className="text-[#8a7a5f] italic py-8 text-center">No changes match the current filters.</div>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ state, items }) => (
            <section key={state}>
              <h2 className="text-sm uppercase tracking-wider text-[#8a7a5f] mb-2">
                {state.replace(/_/g, " ")} <span className="text-[#5a4f3a]">({items.length})</span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {items.map((c) => <ChangeCard key={c.name} change={c} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryBand({ summary }: { summary: ProjectSnapshot["summary"] }) {
  const cells: [string, number, string][] = [
    ["Active", summary.active, "text-[#e8d8b0]"],
    ["Archived", summary.archived, "text-[#8a7a5f]"],
    ["Verified", summary.verified, "text-green-400"],
    ["In Progress", summary.inProgress, "text-amber-400"],
    ["Planned", summary.planned, "text-blue-400"],
    ["Draft", summary.draft, "text-[#8a7a5f]"],
    ["Review", summary.review, "text-purple-400"],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {cells.map(([label, value, color]) => (
        <div key={label} className="bg-[#241c14] rounded border border-[#e8d8b022] px-3 py-2">
          <div className={`text-2xl font-bold ${color}`}>{value}</div>
          <div className="text-[11px] uppercase tracking-wider text-[#8a7a5f]">{label}</div>
        </div>
      ))}
    </div>
  );
}

function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-sm text-[#8a7a5f]">
      <span>{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[#241c14] border border-[#e8d8b055] rounded px-2 py-1 text-[#e8d8b0] cursor-pointer"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function ChangeCard({ change: c }: { change: ChangeRecord }) {
  const tp = c.taskProgress;
  return (
    <div className="bg-[#241c14] rounded-lg border border-[#e8d8b022] p-4 hover:border-[#e8d8b055] transition-colors">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="font-semibold text-[#e8d8b0]">{c.title}</div>
          <div className="text-xs text-[#5a4f3a]">{c.name}</div>
        </div>
        <LifecycleBadge state={c.lifecycle} />
      </div>

      <div className="flex flex-wrap gap-2 text-xs mb-2">
        {c.missingArtifacts.length > 0 ? (
          <span className="text-red-400">missing: {c.missingArtifacts.join(", ")}</span>
        ) : (
          <span className="text-[#5a4f3a]">artifacts complete</span>
        )}
        <span className="text-[#5a4f3a]">·</span>
        <span className="text-[#8a7a5f]">
          {c.specCoverage.missing
            ? "no specs"
            : `${c.specCoverage.requirements} req / ${c.specCoverage.scenarios} sc`}
        </span>
      </div>

      {!tp.unknown && tp.total > 0 && (
        <div className="mb-2">
          <div className="flex justify-between text-xs text-[#8a7a5f] mb-1">
            <span>{tp.completed}/{tp.total} tasks</span>
            <span>{tp.percent}%</span>
          </div>
          <div className="h-1.5 bg-[#1a1410] rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full"
              style={{ width: `${tp.percent}%` }}
            />
          </div>
        </div>
      )}

      {tp.unknown && <div className="text-xs text-[#8a7a5f] italic mb-2">no tasks file</div>}

      {c.nextAction && (
        <div className="text-xs mb-2">
          <span className="text-[#5a4f3a]">next: </span>
          <span className="text-[#d8c8a8]">{c.nextAction}</span>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs">
        {c.verification.verified ? (
          <span className="text-green-400">✓ verified</span>
        ) : c.verification.verifyJsonPresent ? (
          <span className="text-red-400">✗ verify present, gate not pass</span>
        ) : (
          <span className="text-[#5a4f3a]">○ unverified</span>
        )}
        {c.verification.traceabilityPresent && (
          <span className="text-[#5a4f3a]">· traceability</span>
        )}
      </div>

      <div className="mt-2 text-[10px] text-[#3a3328] overflow-hidden whitespace-nowrap overflow-ellipsis" title={c.path}>
        {c.path}
      </div>

      {c.warnings.length > 0 && (
        <div className="mt-2 text-xs text-amber-400">
          ⚠ {c.warnings.join("; ")}
        </div>
      )}
    </div>
  );
}

function LifecycleBadge({ state }: { state: LifecycleState }) {
  const colors: Record<LifecycleState, string> = {
    draft: "bg-neutral-800 text-neutral-400",
    planned: "bg-blue-900/40 text-blue-400",
    in_progress: "bg-amber-900/40 text-amber-400",
    review: "bg-purple-900/40 text-purple-400",
    verified: "bg-green-900/40 text-green-400",
    archived: "bg-neutral-800 text-neutral-500",
    blocked: "bg-red-900/40 text-red-400",
  };
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${colors[state]}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

const LIFECYCLE_ORDER: LifecycleState[] = [
  "blocked",
  "in_progress",
  "review",
  "verified",
  "planned",
  "draft",
  "archived",
];

function groupByLifecycle(changes: ChangeRecord[]): { state: LifecycleState; items: ChangeRecord[] }[] {
  const buckets = new Map<LifecycleState, ChangeRecord[]>();
  for (const c of changes) {
    if (!buckets.has(c.lifecycle)) buckets.set(c.lifecycle, []);
    buckets.get(c.lifecycle)!.push(c);
  }
  return LIFECYCLE_ORDER.filter((s) => buckets.has(s)).map((state) => ({
    state,
    items: buckets.get(state)!,
  }));
}

export default StatusDashboardPage;
