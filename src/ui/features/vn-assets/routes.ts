import { existsSync, readFileSync } from "node:fs";
import { handleVNChoice, handleVNChoices, handleVNBranchSwitch } from "./api/choice";
import { handleVNAssets, handleVNAssetFile, handleVNAssetUpload, handleVNAssetDelete } from "./api/assets";
import { handleVNPortrait, handleVNBackground } from "./api/media";
import { handleVNScene } from "./api/scene";
import { handleVNStateSave, handleVNStateLoad } from "./api/state";
import { featureDir } from "../../services/session-store";
import type { UIServerDeps } from "../../types";

export async function routes(req: Request, pathname: string, deps?: UIServerDeps): Promise<Response | null> {
  const API_PREFIX = "/api/";
  if (pathname.startsWith(API_PREFIX)) {
    const route = pathname.slice(API_PREFIX.length);

    if (route === "vn/choice" && req.method === "POST") return handleVNChoice(req, deps);

    const vnChoicesMatch = route.match(/^vn\/choices\/([a-zA-Z0-9_-]+)$/);
    if (vnChoicesMatch && req.method === "GET") return handleVNChoices(vnChoicesMatch[1], deps);

    if (route === "vn/switch-branch" && req.method === "POST") return handleVNBranchSwitch(req, deps);

    if (route === "vn/assets" && req.method === "GET") return handleVNAssets(deps);

    const portraitMatch = route.match(/^vn\/portrait\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
    if (portraitMatch) return handleVNPortrait(portraitMatch[1], portraitMatch[2], deps, req);

    const bgMatch = route.match(/^vn\/background\/([a-zA-Z0-9_-]+)$/);
    if (bgMatch) return handleVNBackground(bgMatch[1], deps, req);

    const assetFileMatch = route.match(/^vn\/asset-file\/([a-z]+)\/([a-zA-Z0-9_\-\.]+)$/);
    if (assetFileMatch) return handleVNAssetFile(assetFileMatch[1], assetFileMatch[2], deps, req);

    if (route === "vn/assets/upload" && req.method === "POST") return handleVNAssetUpload(req, deps);
    if (route === "vn/assets/delete" && req.method === "POST") return handleVNAssetDelete(req, deps);

    const sceneMatch = route.match(/^vn\/scene\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
    if (sceneMatch) return handleVNScene(sceneMatch[1], sceneMatch[2], deps);

    if (route === "vn/state" && req.method === "POST") return handleVNStateSave(req, deps);

    const vnStateLoadMatch = route.match(/^vn\/state\/([a-zA-Z0-9_-]+)$/);
    if (vnStateLoadMatch && req.method === "GET") return handleVNStateLoad(req, vnStateLoadMatch[1], deps);

    return null; // not a vn-assets API route — let other features/fallback try
  }

  return null;
}
