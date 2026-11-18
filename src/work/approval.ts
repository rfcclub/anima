/**
 * The two small formats shared with `mesh work` (colony-mesh): the issue body digest and the job's work reference
 * `w<10 hex>.<12 hex>`.
 */

import { createHash } from "node:crypto";

/** First 12 hex characters of the SHA-256 of the issue body, as `mesh work` computes it. */
export function issueDigest12(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "", "utf8").digest("hex").slice(0, 12);
}

export interface WorkRef { workId: string; digest: string }

const WORK_REF = /^(w[0-9a-f]{10})\.([0-9a-f]{12})$/;

export function parseWorkRef(ref: string | undefined | null): WorkRef | null {
  const match = WORK_REF.exec(ref ?? "");
  return match ? { workId: match[1]!, digest: match[2]! } : null;
}
