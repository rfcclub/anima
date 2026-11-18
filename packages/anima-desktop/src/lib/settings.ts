/**
 * Settings + connection-profile model for ANIMA Desktop.
 * Pure functions only — persistence lives in storage.ts.
 */

export const DEFAULT_SERVER_URL = "https://host.example.ts.net";

export type ViewId = "town" | "openclaw" | "chat";

export interface RemotePorts {
  town: number;
  openclaw: number;
  api: number;
  chat: number;
}

export interface ApiProfile {
  name: string;
  type: "api";
  baseUrl: string;
  chatUrl?: string;
}

export interface SshProfile {
  name: string;
  type: "ssh";
  host: string;
  port: number;
  user: string;
  /** Path to a private key file. Ignored when `agent` is true. */
  keyPath?: string;
  /** Use the running ssh-agent for auth. */
  agent?: boolean;
  remotePorts: RemotePorts;
}

export type Profile = ApiProfile | SshProfile;

export type Theme = "dark" | "light";

export interface Settings {
  profiles: Profile[];
  activeProfile: string;
  lastView: ViewId;
  theme: Theme;
}

export const DEFAULT_REMOTE_PORTS: RemotePorts = {
  town: 3000,
  openclaw: 18789,
  api: 3700,
  chat: 3700,
};

export function defaultSettings(): Settings {
  const profile: ApiProfile = {
    name: "default",
    type: "api",
    baseUrl: DEFAULT_SERVER_URL,
  };
  return {
    profiles: [profile],
    activeProfile: profile.name,
    lastView: "town",
    theme: "dark",
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns a list of human-readable validation errors; empty list = valid. */
export function validateProfile(profile: Profile): string[] {
  const errors: string[] = [];
  if (!profile.name || profile.name.trim() === "") {
    errors.push("Profile name must not be empty");
  }
  if (profile.type === "api") {
    if (!isHttpUrl(profile.baseUrl)) {
      errors.push("Server URL must start with http:// or https://");
    }
    if (profile.chatUrl !== undefined && !isHttpUrl(profile.chatUrl)) {
      errors.push("Chat URL must start with http:// or https://");
    }
  } else {
    if (!profile.host || profile.host.trim() === "") {
      errors.push("SSH host must not be empty");
    }
    if (!profile.user || profile.user.trim() === "") {
      errors.push("SSH user must not be empty");
    }
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
      errors.push("SSH port must be between 1 and 65535");
    }
    for (const [key, port] of Object.entries(profile.remotePorts)) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`Remote port for ${key} must be between 1 and 65535`);
      }
    }
  }
  return errors;
}

/** Add a profile or replace the existing one with the same name. Immutable. */
export function upsertProfile(settings: Settings, profile: Profile): Settings {
  const exists = settings.profiles.some((p) => p.name === profile.name);
  const profiles = exists
    ? settings.profiles.map((p) => (p.name === profile.name ? profile : p))
    : [...settings.profiles, profile];
  return { ...settings, profiles };
}

/** Remove a profile by name. Never removes the last one. Fixes up activeProfile. */
export function removeProfile(settings: Settings, name: string): Settings {
  if (settings.profiles.length <= 1) return settings;
  const profiles = settings.profiles.filter((p) => p.name !== name);
  if (profiles.length === settings.profiles.length) return settings;
  const activeProfile = profiles.some((p) => p.name === settings.activeProfile)
    ? settings.activeProfile
    : profiles[0]!.name;
  return { ...settings, profiles, activeProfile };
}

/** Switch the active profile. Unknown names are ignored. */
export function setActiveProfile(settings: Settings, name: string): Settings {
  if (!settings.profiles.some((p) => p.name === name)) return settings;
  return { ...settings, activeProfile: name };
}

export function getActiveProfile(settings: Settings): Profile {
  return (
    settings.profiles.find((p) => p.name === settings.activeProfile) ??
    settings.profiles[0]!
  );
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settings, null, 2);
}

const VIEWS: ViewId[] = ["town", "openclaw", "chat"];
const THEMES: Theme[] = ["dark", "light"];

/**
 * Parse a settings JSON string. Tolerant: garbage input, missing fields, or
 * invalid profiles all degrade gracefully toward defaults instead of throwing.
 */
export function parseSettings(raw: string): Settings {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return defaultSettings();
  }
  if (typeof data !== "object" || data === null) return defaultSettings();
  const obj = data as Record<string, unknown>;

  const rawProfiles = Array.isArray(obj.profiles) ? obj.profiles : [];
  const profiles: Profile[] = [];
  for (const p of rawProfiles) {
    const parsed = coerceProfile(p);
    if (parsed && validateProfile(parsed).length === 0) profiles.push(parsed);
  }
  if (profiles.length === 0) return defaultSettings();

  const activeProfile =
    typeof obj.activeProfile === "string" &&
    profiles.some((p) => p.name === obj.activeProfile)
      ? (obj.activeProfile as string)
      : profiles[0]!.name;

  const lastView = VIEWS.includes(obj.lastView as ViewId)
    ? (obj.lastView as ViewId)
    : "town";
  const theme = THEMES.includes(obj.theme as Theme) ? (obj.theme as Theme) : "dark";

  return { profiles, activeProfile, lastView, theme };
}

function coerceProfile(p: unknown): Profile | null {
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  if (o.type === "api") {
    if (typeof o.baseUrl !== "string") return null;
    const profile: ApiProfile = { name: o.name, type: "api", baseUrl: o.baseUrl };
    if (typeof o.chatUrl === "string") profile.chatUrl = o.chatUrl;
    return profile;
  }
  if (o.type === "ssh") {
    if (typeof o.host !== "string" || typeof o.user !== "string") return null;
    const rp = (typeof o.remotePorts === "object" && o.remotePorts !== null
      ? o.remotePorts
      : {}) as Record<string, unknown>;
    const remotePorts: RemotePorts = {
      town: typeof rp.town === "number" ? rp.town : DEFAULT_REMOTE_PORTS.town,
      openclaw:
        typeof rp.openclaw === "number" ? rp.openclaw : DEFAULT_REMOTE_PORTS.openclaw,
      api: typeof rp.api === "number" ? rp.api : DEFAULT_REMOTE_PORTS.api,
      chat: typeof rp.chat === "number" ? rp.chat : DEFAULT_REMOTE_PORTS.chat,
    };
    const profile: SshProfile = {
      name: o.name,
      type: "ssh",
      host: o.host,
      port: typeof o.port === "number" ? o.port : 22,
      user: o.user,
      remotePorts,
    };
    if (typeof o.keyPath === "string") profile.keyPath = o.keyPath;
    if (typeof o.agent === "boolean") profile.agent = o.agent;
    return profile;
  }
  return null;
}
