/** Plain-language lines for a work on the castle's work page (WL-7). */

import type { ProjectedWork } from "../../../../work/projection";

export interface WorkDescription {
  title: string;
  stateLabel: string;
  capsLine: string;
  progressLine: string;
  blockedLine: string | null;
  prLink: { label: string; url: string } | null;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function describeWork(work: ProjectedWork): WorkDescription {
  const c = work.caps;
  return {
    title: `${work.repo}#${work.issue}`,
    stateLabel: work.state,
    capsLine: `sessions ${c.sessionsUsed}/${c.maxSessions} · time ${duration(c.execMsUsed)} of ${duration(c.workWallMs)}`,
    progressLine: work.lastProgress ? `last: ${work.lastProgress.kind} at ${work.lastProgress.at}` : "no progress yet",
    blockedLine: work.blockedReason ? `Blocked: ${work.blockedReason}` : null,
    prLink: work.pr && work.pr.url ? { label: `PR #${work.pr.number}`, url: work.pr.url } : null,
  };
}
