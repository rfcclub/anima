/**
 * Backend API URL setting. Storage backend is injected (localStorage in the
 * app, in-memory in tests).
 */

export const DEFAULT_API_URL = "http://localhost:3000";

const KEY = "anima.apiUrl";

export interface StorageBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Returns the normalized URL, or null when invalid. */
export function normalizeApiUrl(raw: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export interface SettingsStore {
  getApiUrl(): string;
  /** Returns false (and keeps the old value) when the URL is invalid. */
  setApiUrl(raw: string): boolean;
  subscribe(fn: (url: string) => void): () => void;
}

export function createSettingsStore(backend: StorageBackend): SettingsStore {
  const subscribers = new Set<(url: string) => void>();

  return {
    getApiUrl() {
      const stored = backend.get(KEY);
      return stored !== null && normalizeApiUrl(stored) !== null
        ? normalizeApiUrl(stored)!
        : DEFAULT_API_URL;
    },
    setApiUrl(raw: string) {
      const normalized = normalizeApiUrl(raw);
      if (normalized === null) return false;
      backend.set(KEY, normalized);
      for (const fn of subscribers) fn(normalized);
      return true;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

export function localStorageBackend(): StorageBackend {
  return {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        // storage unavailable; value stays in memory for this session
      }
    },
  };
}
