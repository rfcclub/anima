/**
 * Retention for castle work roots (anima #135, WL-11).
 *
 * Nothing here deletes. It lists the works whose root an operator may remove: accepted at least seven days ago and
 * clean (no uncommitted changes, no commits that no remote has). Blocked works, works in any other state, dirty
 * trees and trees that cannot be read are never listed. The work record, its events and its receipt stay in the
 * store whatever happens to the root.
 */

import { isDirty as treeIsDirty } from "./workspace";
import type { WorkStore } from "./store";

export const ACCEPTED_RETENTION_MS = 7 * 24 * 3_600_000;

export interface CleanupCandidate {
  workId: string;
  root: string;
  acceptedAt: string;
}

export interface RetentionOptions {
  now: number;
  /** Whether the tree holds unmerged work. Defaults to the Git check; an error counts as dirty. */
  isDirty?: (tree: string) => boolean;
}

export function cleanupCandidates(store: WorkStore, options: RetentionOptions): CleanupCandidate[] {
  const dirty = options.isDirty ?? treeIsDirty;
  const out: CleanupCandidate[] = [];
  for (const work of store.listWorks()) {
    if (work.state !== "accepted") continue;
    const accepted = [...store.listEvents(work.workId)].reverse().find((event) => event.kind === "accepted");
    if (!accepted) continue; // accepted without a recorded moment: keep it
    if (options.now - Date.parse(accepted.at) < ACCEPTED_RETENTION_MS) continue;
    let unmerged = true;
    try {
      unmerged = dirty(`${work.root}/tree`);
    } catch {
      unmerged = true;
    }
    if (unmerged) continue;
    out.push({ workId: work.workId, root: work.root, acceptedAt: accepted.at });
  }
  return out;
}
