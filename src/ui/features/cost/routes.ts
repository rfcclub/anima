import { handleCost } from "./api/cost";
import type { UIServerDeps } from "../../types";

export async function routes(req: Request, pathname: string, _deps?: UIServerDeps): Promise<Response | null> {
  if (pathname === "/api/cost" && req.method === "GET") {
    return handleCost(req);
  }
  return null;
}
