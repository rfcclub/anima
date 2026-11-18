import { handleTalk, agentStream } from "./api/talk";
import { handleSession, handleNew, handleTurns, handleHistory, handleBranches, handleBack } from "./api/session";
import { handleMeet } from "./api/meet";
import { handleSetConfig, handleModels, handleMode } from "./api/config";
import { handleCompact, handleRetry, handleSummary, handleReview, handleExport } from "./api/lifecycle";
import type { UIServerDeps } from "../../types";

export async function routes(req: Request, pathname: string, deps?: UIServerDeps): Promise<Response | null> {
  const API_PREFIX = "/api/";
  if (pathname.startsWith(API_PREFIX)) {
    const route = pathname.slice(API_PREFIX.length);

    const talkMatch = route.match(/^talk\/([a-zA-Z0-9_-]+)$/);
    if (talkMatch && req.method === "POST") return handleTalk(req, talkMatch[1], deps);

    const sessionMatch = route.match(/^session\/([a-zA-Z0-9_-]+)$/);
    if (sessionMatch && req.method === "GET") return handleSession(sessionMatch[1], deps);

    const turnsMatch = route.match(/^turns\/([a-zA-Z0-9_-]+)$/);
    if (turnsMatch && req.method === "GET") return handleTurns(turnsMatch[1], deps);

    const newMatch = route.match(/^new\/([a-zA-Z0-9_-]+)$/);
    if (newMatch && req.method === "POST") return handleNew(newMatch[1], deps);

    const configMatch = route.match(/^config\/([a-zA-Z0-9_-]+)$/);
    if (configMatch && req.method === "POST") return handleSetConfig(req, configMatch[1], deps);

    if (route === "models" && req.method === "GET") return handleModels(deps);
    if (route === "mode" && (req.method === "GET" || req.method === "POST")) return handleMode(req, deps);

    const compactMatch = route.match(/^compact\/([a-zA-Z0-9_-]+)$/);
    if (compactMatch && req.method === "POST") return handleCompact(compactMatch[1], deps);

    const retryMatch = route.match(/^retry\/([a-zA-Z0-9_-]+)$/);
    if (retryMatch && req.method === "POST") return handleRetry(retryMatch[1], deps);

    const summaryMatch = route.match(/^summary\/([a-zA-Z0-9_-]+)$/);
    if (summaryMatch && req.method === "POST") return handleSummary(summaryMatch[1], deps);

    const reviewMatch = route.match(/^review\/([a-zA-Z0-9_-]+)$/);
    if (reviewMatch && req.method === "POST") return handleReview(reviewMatch[1], deps);

    const exportMatch = route.match(/^export\/([a-zA-Z0-9_-]+)$/);
    if (exportMatch && req.method === "GET") return handleExport(exportMatch[1], deps);

    const historyMatch = route.match(/^history\/([a-zA-Z0-9_-]+)$/);
    if (historyMatch && req.method === "GET") return handleHistory(req, historyMatch[1], deps);

    const branchesMatch = route.match(/^branches\/([a-zA-Z0-9_-]+)$/);
    if (branchesMatch && req.method === "GET") return handleBranches(branchesMatch[1], deps);

    const backMatch = route.match(/^back\/([a-zA-Z0-9_-]+)$/);
    if (backMatch && req.method === "POST") return handleBack(backMatch[1], deps);

    if (route === "meet" && req.method === "POST") return handleMeet(req, deps);

    return null;
  }

  return null;
}
