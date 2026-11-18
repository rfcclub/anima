import { handleWork } from "./api/work";
import type { UIServerDeps } from "../../types";

export async function routes(req: Request, pathname: string, _deps?: UIServerDeps): Promise<Response | null> {
  if (pathname === "/api/work" && req.method === "GET") return handleWork(req);
  return null;
}
