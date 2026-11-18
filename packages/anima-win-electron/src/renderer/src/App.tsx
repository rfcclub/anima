import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusPill } from "./components/StatusPill";
import { Overview } from "./components/Overview";
import { Entities } from "./components/Entities";
import { SettingsView } from "./components/SettingsView";
import { createSettingsStore, localStorageBackend } from "./lib/settings";
import { createApiClient, defaultTransport } from "./lib/api";
import { createHealthPoller, type PollStatus } from "./lib/poller";

const TITLES: Record<ViewId, string> = {
  overview: "Overview",
  entities: "Entities",
  settings: "Settings",
};

export default function App() {
  const [view, setView] = useState<ViewId>("overview");
  const [status, setStatus] = useState<PollStatus | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [epoch, setEpoch] = useState(0);

  const store = useMemo(() => createSettingsStore(localStorageBackend()), []);
  const api = useMemo(
    () => createApiClient(() => store.getApiUrl(), defaultTransport()),
    [store],
  );

  const pollerRef = useRef<ReturnType<typeof createHealthPoller> | null>(null);

  useEffect(() => {
    setApiUrl(store.getApiUrl());

    const poller = createHealthPoller({
      probe: async () => {
        try {
          const health = await api.getHealth();
          return health.status === "ok";
        } catch {
          return false;
        }
      },
      onStatus: setStatus,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    pollerRef.current = poller;
    void poller.start();

    // Settings change → re-target the poll immediately and refetch views.
    const unsubscribe = store.subscribe((url) => {
      setApiUrl(url);
      setStatus(null);
      setEpoch((e) => e + 1);
      void poller.restart();
    });

    return () => {
      unsubscribe();
      poller.stop();
      pollerRef.current = null;
    };
  }, [api, store]);

  return (
    <div className="flex h-full">
      <Sidebar active={view} onSelect={setView} />

      <main className="flex h-full min-w-0 flex-1 flex-col">
        <div
          className="flex h-12 shrink-0 items-center justify-between border-b px-4"
          style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        >
          <span className="text-sm font-semibold">{TITLES[view]}</span>
          <StatusPill status={status} apiUrl={apiUrl} />
        </div>

        <div className="min-h-0 flex-1">
          {view === "overview" && <Overview api={api} status={status} epoch={epoch} />}
          {view === "entities" && <Entities api={api} status={status} epoch={epoch} />}
          {view === "settings" && <SettingsView store={store} />}
        </div>
      </main>
    </div>
  );
}
