import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { CostReporter } from "../../../../cost/reporter";
import { json } from "../../../utils/http";


export function handleCost(req: Request): Response {
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? undefined;
  const until = url.searchParams.get("until") ?? undefined;
  const agentId = url.searchParams.get("agent") ?? undefined;

  const dbPath = process.env.ANIMA_COST_DB ?? join(homedir(), ".anima", "cost.db");
  if (!existsSync(dbPath)) {
    return json({ summary: null, byModel: [], byAgent: [], byProvider: [], message: "No cost data yet" });
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const reporter = new CostReporter(db);
    const filter = { since, until, agentId };

    // summary and the breakdowns are the v2 report (calls counted from parents);
    // rows from before call records existed are reported apart in `legacy`.
    return json({
      summary: reporter.summary(filter),
      byModel: reporter.byModel(filter),
      byAgent: reporter.byAgent(filter),
      byProvider: reporter.byProvider(filter),
      legacy: reporter.legacy(filter),
    });
  } catch (error) {
    if (error instanceof RangeError) return json({ error: error.message }, 400);
    throw error;
  } finally {
    db.close();
  }
}
