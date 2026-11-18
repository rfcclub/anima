import type { ApiProfile } from "./settings";

/** URLs for each view plus the API root used for health checks. */
export interface ResolvedEndpoints {
  town: string;
  openclaw: string;
  chat: string;
  api: string;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Derive the view URLs for an API-transport profile. */
export function resolveApiEndpoints(profile: ApiProfile): ResolvedEndpoints {
  const base = stripTrailingSlash(profile.baseUrl);
  return {
    town: `${base}/town/`,
    openclaw: `${base}/openclaw/`,
    chat: profile.chatUrl ?? `${base}/chat/`,
    api: base,
  };
}

/** Health endpoint for a given API root. */
export function healthUrl(apiRoot: string): string {
  return `${stripTrailingSlash(apiRoot)}/anima/health`;
}
