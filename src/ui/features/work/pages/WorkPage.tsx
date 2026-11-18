import { useEffect, useState } from "react";
import { describeWork } from "../lib/describe";
import type { WorkProjection } from "../../../../work/projection";

/**
 * The castle's work page (WL-7): what each work is doing, read from ANIMA's own sanitised record of
 * it. Polls /api/work; it holds no Mesh credential and shows no transcript.
 */
export function WorkPage() {
  const [data, setData] = useState<WorkProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/work");
        if (!res.ok) throw new Error(`/api/work answered ${res.status}`);
        const body = (await res.json()) as WorkProjection;
        if (alive) { setData(body); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <div className="min-h-screen bg-castle-bg p-6 text-castle-cream">
      <a href="/castle" className="text-sm text-castle-cream hover:text-white">◂ Castle</a>
      <h1 className="mt-2 mb-4 text-2xl tracking-wide">Work</h1>
      {error && <p className="text-sm">Could not read work state: {error}</p>}
      {data && data.works.length === 0 && <p className="text-sm">No work yet.</p>}
      <ul className="space-y-3">
        {data?.works.map((work) => {
          const d = describeWork(work);
          return (
            <li key={work.workId} className="rounded-md border-2 border-castle-cream p-3" data-testid="work-item">
              <div className="flex items-baseline gap-3">
                <span className="text-lg">{d.title}</span>
                <span className="text-sm">{d.stateLabel}</span>
                <span className="text-sm">{work.author} · {work.provider}/{work.model}</span>
                {d.prLink && <a href={d.prLink.url} className="text-sm underline" target="_blank" rel="noreferrer">{d.prLink.label}</a>}
              </div>
              {d.blockedLine && <p className="mt-1 text-sm">{d.blockedLine}</p>}
              <p className="mt-1 text-sm">{d.capsLine}</p>
              <p className="mt-1 text-sm">{d.progressLine}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
