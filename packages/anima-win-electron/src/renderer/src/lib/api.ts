/**
 * Typed client for the ANIMA REST API. The transport is injected: in the app
 * it is the Electron IPC fetch proxy (CORS-free), in tests a mock.
 */

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  agents: string[];
}

export interface TrustDomain {
  domain: string;
  score: number;
  samples: number;
}

export interface ColonyAgent {
  name: string;
  substrateName?: string;
  substratePath?: string;
  platform?: string;
  squad?: string | null;
  continuityMode?: string;
  trust?: { domains?: TrustDomain[] };
  [key: string]: unknown;
}

export interface ColonyResponse {
  agents: ColonyAgent[];
  agora: Record<string, unknown>;
}

export interface TransportResult {
  ok: boolean;
  status: number;
  json?: unknown;
  error?: string;
}

export type Transport = (url: string) => Promise<TransportResult>;

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  getColony(): Promise<ColonyResponse>;
  getAgent(id: string): Promise<ColonyAgent>;
}

/**
 * `getBaseUrl` is read at every call, so a settings change re-targets all
 * subsequent requests immediately.
 */
export function createApiClient(
  getBaseUrl: () => string,
  transport: Transport,
): ApiClient {
  async function get<T>(path: string): Promise<T> {
    const url = `${getBaseUrl()}${path}`;
    const res = await transport(url);
    if (!res.ok) {
      throw new Error(res.error ?? `HTTP ${res.status} from ${url}`);
    }
    return res.json as T;
  }

  return {
    getHealth: () => get<HealthResponse>("/health"),
    getColony: () => get<ColonyResponse>("/api/colony"),
    getAgent: (id: string) =>
      get<ColonyAgent>(`/api/agent/${encodeURIComponent(id)}`),
  };
}

/**
 * Default transport: prefer the Electron IPC proxy (immune to CORS); fall
 * back to plain fetch when running in a bare browser.
 */
export function defaultTransport(): Transport {
  return async (url: string) => {
    if (typeof window !== "undefined" && window.anima) {
      return window.anima.fetchJson(url);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        // non-JSON body
      }
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
