/**
 * Worker process for the genuine cross-process concurrency test in
 * domain-revisions.test.ts. Args: dbPath agentId scope count
 */
import { DomainRevisions } from "../../src/domain-revisions";

const [dbPath, agentId, scope, countStr] = process.argv.slice(2);
const count = Number(countStr);

const revisions = new DomainRevisions(dbPath);
for (let i = 0; i < count; i++) {
  revisions.incrementRevision(agentId, scope as "identity" | "private" | "heartwood");
}
revisions.close();
