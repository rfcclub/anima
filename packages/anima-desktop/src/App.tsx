import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type NavId } from "./components/Sidebar";
import { StatusPill, type ConnStatus } from "./components/StatusPill";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { IframeHost } from "./components/IframeHost";
import { SettingsView } from "./components/SettingsView";
import {
  getActiveProfile,
  removeProfile,
  setActiveProfile,
  upsertProfile,
  type Profile,
  type Settings,
  type Theme,
  type ViewId,
} from "./lib/settings";
import { healthUrl, resolveApiEndpoints, type ResolvedEndpoints } from "./lib/endpoints";
import { HealthMonitor } from "./lib/health";
import { loadSettings, saveSettings } from "./lib/storage";
import {
  connectSsh,
  disconnectSsh,
  onEndpointsChanged,
  onSshStatus,
  PASSPHRASE_REQUIRED,
} from "./lib/ssh-bridge";

const VIEW_TITLES: Record<NavId, string> = {
  town: "Agent Town",
  openclaw: "OpenClaw",
  chat: "Chat",
  settings: "Settings",
};

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [nav, setNav] = useState<NavId>("town");
  const [status, setStatus] = useState<ConnStatus>("reconnecting");
  const [endpoints, setEndpoints] = useState<ResolvedEndpoints | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passphraseAsk, setPassphraseAsk] = useState<null | { error?: string }>(null);
  const [sshError, setSshError] = useState<string | null>(null);

  const monitorRef = useRef<HealthMonitor | null>(null);
  const passphraseInputRef = useRef<HTMLInputElement>(null);

  // ── Load settings once ────────────────────────────────────────────────
  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setNav(s.lastView);
    });
  }, []);

  const persist = useCallback((next: Settings) => {
    setSettings(next);
    void saveSettings(next);
  }, []);

  const activeProfile: Profile | null = useMemo(
    () => (settings ? getActiveProfile(settings) : null),
    [settings],
  );

  // ── Connect the active profile ────────────────────────────────────────
  const connectProfile = useCallback(async (profile: Profile, passphrase?: string) => {
    monitorRef.current?.stop();
    setSshError(null);

    if (profile.type === "api") {
      await disconnectSsh().catch(() => {});
      const eps = resolveApiEndpoints(profile);
      setEndpoints(eps);
      const monitor = new HealthMonitor({
        probe: async () => {
          try {
            const res = await fetch(healthUrl(eps.api), {
              signal: AbortSignal.timeout(5000),
            });
            return res.ok;
          } catch {
            return false;
          }
        },
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (id) => window.clearTimeout(id),
        onEvent: (e) => {
          setStatus(e.status);
          if (e.recovered) setReloadToken((t) => t + 1);
        },
      });
      monitorRef.current = monitor;
      setStatus("reconnecting");
      await monitor.start();
      return;
    }

    // SSH transport — Rust owns health + reconnect
    setStatus("reconnecting");
    setEndpoints(null);
    try {
      const eps = await connectSsh(profile, passphrase);
      setEndpoints(eps);
      setStatus("connected");
      setPassphraseAsk(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(PASSPHRASE_REQUIRED)) {
        setPassphraseAsk({
          error: passphrase ? "Wrong passphrase — try again" : undefined,
        });
      } else {
        setStatus("disconnected");
        setSshError(msg);
      }
    }
  }, []);

  useEffect(() => {
    if (activeProfile) void connectProfile(activeProfile);
    return () => monitorRef.current?.stop();
  }, [activeProfile, connectProfile]);

  // ── Rust-side SSH events ──────────────────────────────────────────────
  useEffect(() => {
    if (activeProfile?.type !== "ssh") return;
    const unsubs: Array<() => void> = [];
    void onSshStatus((s) => {
      setStatus(s);
      if (s === "connected") setReloadToken((t) => t + 1);
    }).then((u) => unsubs.push(u));
    void onEndpointsChanged((eps) => setEndpoints(eps)).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [activeProfile]);

  // ── Theme ─────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? "dark";
  }, [settings?.theme]);

  // ── Navigation ────────────────────────────────────────────────────────
  const goTo = useCallback(
    (id: NavId) => {
      setNav(id);
      if (id !== "settings" && settings) {
        persist({ ...settings, lastView: id as ViewId });
      }
    },
    [settings, persist],
  );

  const refresh = useCallback(() => {
    setReloadToken((t) => t + 1);
    void monitorRef.current?.checkNow();
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "1") {
        e.preventDefault();
        goTo("town");
      } else if (e.key === "2") {
        e.preventDefault();
        goTo("openclaw");
      } else if (e.key === "3") {
        e.preventDefault();
        goTo("chat");
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goTo]);

  // ── Command palette ───────────────────────────────────────────────────
  const commands: PaletteCommand[] = useMemo(() => {
    const cmds: PaletteCommand[] = [
      { id: "view-town", label: "Go to Town", hint: "⌘1", run: () => goTo("town") },
      {
        id: "view-openclaw",
        label: "Go to OpenClaw",
        hint: "⌘2",
        run: () => goTo("openclaw"),
      },
      { id: "view-chat", label: "Go to Chat", hint: "⌘3", run: () => goTo("chat") },
      { id: "view-settings", label: "Open Settings", run: () => goTo("settings") },
      { id: "refresh", label: "Refresh all views", hint: "⟳", run: refresh },
      {
        id: "theme",
        label: `Switch to ${settings?.theme === "dark" ? "light" : "dark"} theme`,
        run: () => {
          if (settings)
            persist({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" });
        },
      },
    ];
    for (const p of settings?.profiles ?? []) {
      if (p.name !== settings?.activeProfile) {
        cmds.push({
          id: `profile-${p.name}`,
          label: `Switch profile: ${p.name}`,
          hint: p.type.toUpperCase(),
          run: () => settings && persist(setActiveProfile(settings, p.name)),
        });
      }
    }
    return cmds;
  }, [settings, goTo, refresh, persist]);

  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        active={nav}
        collapsed={collapsed}
        onSelect={goTo}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />

      <main className="relative flex h-full min-w-0 flex-1 flex-col">
        {/* Top strip */}
        <div
          className="flex h-12 shrink-0 items-center justify-between border-b px-4"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <span className="text-sm font-semibold">{VIEW_TITLES[nav]}</span>
          <StatusPill
            status={status}
            profileName={settings.activeProfile}
            onRefresh={refresh}
          />
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1">
          {nav === "settings" ? (
            <SettingsView
              settings={settings}
              onActivate={(name) => persist(setActiveProfile(settings, name))}
              onSave={(p) => persist(upsertProfile(settings, p))}
              onDelete={(name) => persist(removeProfile(settings, name))}
              onTheme={(t: Theme) => persist({ ...settings, theme: t })}
            />
          ) : (
            <IframeHost
              active={nav}
              endpoints={endpoints}
              reloadToken={reloadToken}
              overlay={status === "reconnecting" ? "reconnecting" : null}
            />
          )}
        </div>

        {sshError && nav !== "settings" && (
          <div
            className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border px-4 py-2 text-xs"
            style={{
              background: "var(--panel)",
              borderColor: "var(--bad)",
              color: "var(--bad)",
            }}
          >
            {sshError}{" "}
            <button
              className="ml-2 cursor-pointer underline"
              onClick={() => activeProfile && void connectProfile(activeProfile)}
            >
              Retry
            </button>
          </div>
        )}
      </main>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />

      {/* Passphrase prompt (kept in memory only) */}
      {passphraseAsk && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
        >
          <div
            className="w-96 rounded-xl border p-5"
            style={{ background: "var(--panel)", borderColor: "var(--border)" }}
          >
            <h3 className="mb-1 text-sm font-semibold">SSH key passphrase</h3>
            <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
              The private key is encrypted. Enter its passphrase to connect.
            </p>
            {passphraseAsk.error && (
              <p className="mb-2 text-xs" style={{ color: "var(--bad)" }}>
                {passphraseAsk.error}
              </p>
            )}
            <input
              ref={passphraseInputRef}
              type="password"
              autoFocus
              className="mb-3 w-full rounded-lg border px-3 py-2 text-sm outline-none"
              style={{
                background: "var(--panel-2)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && activeProfile) {
                  void connectProfile(activeProfile, (e.target as HTMLInputElement).value);
                } else if (e.key === "Escape") {
                  setPassphraseAsk(null);
                  setStatus("disconnected");
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                className="cursor-pointer rounded-lg border px-3 py-1.5 text-xs"
                style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                onClick={() => {
                  setPassphraseAsk(null);
                  setStatus("disconnected");
                }}
              >
                Cancel
              </button>
              <button
                className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold"
                style={{ background: "var(--accent)", color: "#14120a" }}
                onClick={() => {
                  if (activeProfile)
                    void connectProfile(
                      activeProfile,
                      passphraseInputRef.current?.value ?? "",
                    );
                }}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
