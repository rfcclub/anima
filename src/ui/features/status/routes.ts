import { scanProjectStatus } from "../../../status/scanner";
import { json } from "../../utils/http";
import type { UIServerDeps } from "../../types";

/**
 * GET /api/projects — read-only project status snapshot.
 *
 * (Named /api/projects, not /api/status, because /api/status is already owned
 * by the castle feature for runtime agent/meeting status.)
 *
 * Walks the OpenSpec/LoomKit tree (default: repo `openspec/`), normalizes each
 * change, and returns the snapshot as JSON. Scanner errors degrade to partial
 * data instead of failing the whole route (design D5).
 *
 * `root` is overridable for tests; production reads `openspec/` relative to CWD.
 */
export async function handleStatus(_req: Request, root?: string): Promise<Response> {
  const openspecRoot = root ?? defaultOpenspecRoot();
  try {
    const snapshot = scanProjectStatus(openspecRoot);
    return json(snapshot, 200);
  } catch (error) {
    // Scanner is defensive internally, but guard the route so a blown scan
    // never 500s the whole dashboard — return an empty shell with a warning.
    console.error("status scanner error:", error);
    return json(emptySnapshot(openspecRoot), 200);
  }
}

/** Feature-route entry point — matches the cost/town/castle convention. */
export async function routes(
  req: Request,
  pathname: string,
  _deps?: UIServerDeps,
): Promise<Response | null> {
  if (pathname === "/api/projects" && req.method === "GET") {
    return handleStatus(req);
  }
  return null;
}

function emptySnapshot(root: string) {
  return {
    generatedAt: new Date().toISOString(),
    root,
    summary: {
      active: 0,
      archived: 0,
      verified: 0,
      draft: 0,
      inProgress: 0,
      planned: 0,
      review: 0,
      blocked: 0,
    },
    activeChanges: [],
    archivedChanges: [],
    error: "scanner_failed",
  };
}

function defaultOpenspecRoot(): string {
  // Both dev (repo CWD) and prod (`~/.anima/`) keep `openspec/` at CWD root.
  return `${process.cwd()}/openspec`;
}
