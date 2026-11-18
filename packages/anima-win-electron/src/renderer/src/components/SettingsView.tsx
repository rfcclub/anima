import { useState } from "react";
import { normalizeApiUrl, type SettingsStore } from "../lib/settings";

interface Props {
  store: SettingsStore;
}

export function SettingsView({ store }: Props) {
  const [value, setValue] = useState(store.getApiUrl());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    if (normalizeApiUrl(value) === null) {
      setError("URL must start with http:// or https://");
      setSaved(false);
      return;
    }
    store.setApiUrl(value);
    setValue(store.getApiUrl());
    setError(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div
        className="mx-auto max-w-xl rounded-xl border p-5"
        style={{ background: "var(--panel)", borderColor: "var(--border)" }}
      >
        <h2 className="mb-1 text-sm font-semibold">Backend API URL</h2>
        <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
          The ANIMA server this client connects to. Applied immediately on save.
        </p>
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="http://localhost:3000"
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none"
            style={{
              background: "var(--panel-2)",
              borderColor: error ? "var(--bad)" : "var(--border)",
              color: "var(--text)",
            }}
          />
          <button
            onClick={save}
            className="cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold"
            style={{ background: "var(--accent)", color: "#14120a" }}
          >
            Save
          </button>
        </div>
        {error && (
          <p className="mt-2 text-xs" style={{ color: "var(--bad)" }}>
            {error}
          </p>
        )}
        {saved && (
          <p className="mt-2 text-xs" style={{ color: "var(--ok)" }}>
            Saved — health poll re-targeted.
          </p>
        )}
      </div>
    </div>
  );
}
