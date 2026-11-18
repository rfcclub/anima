import { useState } from "react";
import {
  DEFAULT_REMOTE_PORTS,
  validateProfile,
  type Profile,
  type Settings,
  type Theme,
} from "../lib/settings";

interface Props {
  settings: Settings;
  onActivate: (name: string) => void;
  onSave: (profile: Profile) => void;
  onDelete: (name: string) => void;
  onTheme: (theme: Theme) => void;
}

type Draft = {
  original?: string; // name of the profile being edited
  name: string;
  type: "api" | "ssh";
  baseUrl: string;
  chatUrl: string;
  host: string;
  port: string;
  user: string;
  keyPath: string;
  agent: boolean;
  town: string;
  openclaw: string;
  api: string;
  chat: string;
};

function emptyDraft(): Draft {
  return {
    name: "",
    type: "api",
    baseUrl: "https://",
    chatUrl: "",
    host: "",
    port: "22",
    user: "",
    keyPath: "~/.ssh/id_ed25519",
    agent: false,
    town: String(DEFAULT_REMOTE_PORTS.town),
    openclaw: String(DEFAULT_REMOTE_PORTS.openclaw),
    api: String(DEFAULT_REMOTE_PORTS.api),
    chat: String(DEFAULT_REMOTE_PORTS.chat),
  };
}

function draftFrom(p: Profile): Draft {
  const d = { ...emptyDraft(), original: p.name, name: p.name, type: p.type };
  if (p.type === "api") {
    d.baseUrl = p.baseUrl;
    d.chatUrl = p.chatUrl ?? "";
  } else {
    d.host = p.host;
    d.port = String(p.port);
    d.user = p.user;
    d.keyPath = p.keyPath ?? "";
    d.agent = p.agent ?? false;
    d.town = String(p.remotePorts.town);
    d.openclaw = String(p.remotePorts.openclaw);
    d.api = String(p.remotePorts.api);
    d.chat = String(p.remotePorts.chat);
  }
  return d;
}

function profileFrom(d: Draft): Profile {
  if (d.type === "api") {
    const p: Profile = { name: d.name.trim(), type: "api", baseUrl: d.baseUrl.trim() };
    if (d.chatUrl.trim()) p.chatUrl = d.chatUrl.trim();
    return p;
  }
  return {
    name: d.name.trim(),
    type: "ssh",
    host: d.host.trim(),
    port: Number(d.port),
    user: d.user.trim(),
    ...(d.agent ? { agent: true } : d.keyPath.trim() ? { keyPath: d.keyPath.trim() } : {}),
    remotePorts: {
      town: Number(d.town),
      openclaw: Number(d.openclaw),
      api: Number(d.api),
      chat: Number(d.chat),
    },
  };
}

const inputCls = "w-full rounded-lg border px-3 py-2 text-sm outline-none";
const inputStyle = {
  background: "var(--panel-2)",
  borderColor: "var(--border)",
  color: "var(--text)",
} as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      {children}
    </label>
  );
}

export function SettingsView({ settings, onActivate, onSave, onDelete, onTheme }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const submit = () => {
    if (!draft) return;
    const profile = profileFrom(draft);
    const errs = validateProfile(profile);
    if (draft.original && draft.original !== profile.name) {
      errs.push("Renaming profiles is not supported — delete and recreate instead");
    }
    if (
      !draft.original &&
      settings.profiles.some((p) => p.name === profile.name)
    ) {
      errs.push(`A profile named "${profile.name}" already exists`);
    }
    setErrors(errs);
    if (errs.length > 0) return;
    onSave(profile);
    setDraft(null);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Profiles */}
        <section
          className="rounded-xl border p-5"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Connection profiles</h2>
            <button
              onClick={() => {
                setErrors([]);
                setDraft(emptyDraft());
              }}
              className="cursor-pointer rounded-lg border px-3 py-1.5 text-xs"
              style={{
                borderColor: "var(--border)",
                color: "var(--accent)",
                background: "var(--accent-dim)",
              }}
            >
              + New profile
            </button>
          </div>

          <div className="space-y-2">
            {settings.profiles.map((p) => {
              const active = p.name === settings.activeProfile;
              return (
                <div
                  key={p.name}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
                  style={{
                    borderColor: active ? "var(--accent)" : "var(--border)",
                    background: "var(--panel-2)",
                  }}
                >
                  <button
                    onClick={() => onActivate(p.name)}
                    title={active ? "Active profile" : "Activate"}
                    className="h-4 w-4 cursor-pointer rounded-full border"
                    style={{
                      borderColor: active ? "var(--accent)" : "var(--muted)",
                      background: active ? "var(--accent)" : "transparent",
                    }}
                  />
                  <div className="flex-1">
                    <div className="text-sm">{p.name}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>
                      {p.type === "api"
                        ? `API · ${p.baseUrl}`
                        : `SSH · ${p.user}@${p.host}:${p.port}`}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setErrors([]);
                      setDraft(draftFrom(p));
                    }}
                    className="cursor-pointer rounded px-2 py-1 text-xs"
                    style={{ color: "var(--muted)" }}
                  >
                    Edit
                  </button>
                  {settings.profiles.length > 1 && (
                    <button
                      onClick={() => onDelete(p.name)}
                      className="cursor-pointer rounded px-2 py-1 text-xs"
                      style={{ color: "var(--bad)" }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Editor */}
          {draft && (
            <div
              className="mt-4 space-y-3 rounded-lg border p-4"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex gap-3">
                <div className="flex-1">
                  <Field label="Profile name">
                    <input
                      className={inputCls}
                      style={inputStyle}
                      value={draft.name}
                      onChange={(e) => set({ name: e.target.value })}
                      placeholder="e.g. my-server"
                    />
                  </Field>
                </div>
                <Field label="Transport">
                  <div
                    className="flex overflow-hidden rounded-lg border"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {(["api", "ssh"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => set({ type: t })}
                        className="cursor-pointer px-4 py-2 text-xs uppercase"
                        style={{
                          background: draft.type === t ? "var(--accent-dim)" : "var(--panel-2)",
                          color: draft.type === t ? "var(--accent)" : "var(--muted)",
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              {draft.type === "api" ? (
                <>
                  <Field label="Server URL">
                    <input
                      className={inputCls}
                      style={inputStyle}
                      value={draft.baseUrl}
                      onChange={(e) => set({ baseUrl: e.target.value })}
                      placeholder="https://host.example.ts.net"
                    />
                  </Field>
                  <Field label="Chat URL (optional — defaults to {server}/chat/)">
                    <input
                      className={inputCls}
                      style={inputStyle}
                      value={draft.chatUrl}
                      onChange={(e) => set({ chatUrl: e.target.value })}
                      placeholder="https://…"
                    />
                  </Field>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <Field label="Host">
                        <input
                          className={inputCls}
                          style={inputStyle}
                          value={draft.host}
                          onChange={(e) => set({ host: e.target.value })}
                          placeholder="IP address or host-1.local"
                        />
                      </Field>
                    </div>
                    <Field label="Port">
                      <input
                        className={inputCls}
                        style={inputStyle}
                        value={draft.port}
                        onChange={(e) => set({ port: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="User">
                      <input
                        className={inputCls}
                        style={inputStyle}
                        value={draft.user}
                        onChange={(e) => set({ user: e.target.value })}
                      />
                    </Field>
                    <Field label="Private key path">
                      <input
                        className={inputCls}
                        style={inputStyle}
                        value={draft.keyPath}
                        onChange={(e) => set({ keyPath: e.target.value })}
                        disabled={draft.agent}
                      />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                    <input
                      type="checkbox"
                      checked={draft.agent}
                      onChange={(e) => set({ agent: e.target.checked })}
                    />
                    Use ssh-agent instead of a key file
                  </label>
                  <div className="grid grid-cols-4 gap-3">
                    {(
                      [
                        ["town", "Town port"],
                        ["openclaw", "OpenClaw port"],
                        ["api", "API port"],
                        ["chat", "Chat port"],
                      ] as const
                    ).map(([k, label]) => (
                      <Field key={k} label={label}>
                        <input
                          className={inputCls}
                          style={inputStyle}
                          value={draft[k]}
                          onChange={(e) => set({ [k]: e.target.value } as Partial<Draft>)}
                        />
                      </Field>
                    ))}
                  </div>
                </>
              )}

              {errors.length > 0 && (
                <ul className="space-y-1 text-xs" style={{ color: "var(--bad)" }}>
                  {errors.map((e) => (
                    <li key={e}>• {e}</li>
                  ))}
                </ul>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={submit}
                  className="cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold"
                  style={{ background: "var(--accent)", color: "#14120a" }}
                >
                  Save profile
                </button>
                <button
                  onClick={() => setDraft(null)}
                  className="cursor-pointer rounded-lg border px-4 py-2 text-xs"
                  style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Appearance */}
        <section
          className="rounded-xl border p-5"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <h2 className="mb-3 text-sm font-semibold">Appearance</h2>
          <div className="flex gap-2">
            {(["dark", "light"] as const).map((t) => (
              <button
                key={t}
                onClick={() => onTheme(t)}
                className="cursor-pointer rounded-lg border px-4 py-2 text-xs capitalize"
                style={{
                  borderColor: settings.theme === t ? "var(--accent)" : "var(--border)",
                  color: settings.theme === t ? "var(--accent)" : "var(--muted)",
                  background: settings.theme === t ? "var(--accent-dim)" : "var(--panel-2)",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
