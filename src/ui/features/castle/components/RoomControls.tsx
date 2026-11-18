import { useCallback, useEffect, useState } from "react";
import { CASTLE } from "../lib/castle-style";

interface ModelOption {
  value: string;
  label: string;
  modelId: string;
}

interface AgentStatus {
  name: string;
  model?: string;
  provider?: string;
}

/** Session controls for a Castle room — the same New/Compact/Model actions
 * Town already exposes (App.tsx's handleRibbonCommand/handleModelChange,
 * SessionInfo.tsx's model select), ported here because Castle had none at
 * all. Requirement: model and session controls must be available in the room,
 * since a long context can degrade and need a fresh start. Talks through
 * the agent's own real Town session (see RoomScreen's sendMessage comment),
 * so these hit the exact same /api/new, /api/compact, /api/config endpoints
 * Town's ribbon uses — no new backend. */
export function RoomControls({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agentInfo, setAgentInfo] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data: { agents?: AgentStatus[] }) => {
        setAgentInfo(data.agents?.find((a) => a.name === agentId) ?? null);
      })
      .catch(() => {});
  }, [agentId]);

  useEffect(() => {
    refreshStatus();
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models?: ModelOption[] }) => setModels(data.models ?? []))
      .catch(() => {});
    const id = setInterval(refreshStatus, 5000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const runCommand = useCallback((cmd: "new" | "compact") => {
    setBusy(true);
    fetch(`/api/${cmd}/${agentId}`, { method: "POST" })
      .then(() => refreshStatus())
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [agentId, refreshStatus]);

  const handleModelChange = useCallback((value: string) => {
    if (!value) return;
    setBusy(true);
    fetch(`/api/config/${agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: value }),
    })
      .then(() => refreshStatus())
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [agentId, refreshStatus]);

  const currentModelValue = models.find((m) => m.modelId === agentInfo?.model)?.value ?? "";

  const btnStyle: React.CSSProperties = {
    borderRadius: 6,
    border: `2px solid ${CASTLE.cream}`,
    background: CASTLE.bgTranslucent,
    color: CASTLE.cream,
    fontSize: 13,
    letterSpacing: "0.03em",
    padding: "4px 10px",
    cursor: busy ? "wait" : "pointer",
    pointerEvents: "auto",
  };

  return (
    <div
      data-testid="room-controls"
      className="absolute pointer-events-none z-10"
      style={{ position: "absolute", top: 56, right: 24, zIndex: 10 }}
    >
      <button
        type="button"
        data-testid="room-controls-toggle"
        onClick={() => setOpen((o) => !o)}
        style={{ ...btnStyle, pointerEvents: "auto" }}
        title="Session controls"
      >
        ⚙
      </button>
      {open && (
        <div
          data-testid="room-controls-panel"
          style={{
            position: "absolute",
            top: 40,
            right: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 12,
            borderRadius: 8,
            border: `2px solid ${CASTLE.cream}`,
            background: CASTLE.bg,
            pointerEvents: "auto",
            minWidth: 220,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="room-controls-new"
              disabled={busy}
              onClick={() => runCommand("new")}
              style={btnStyle}
              title="Start new session"
            >
              New
            </button>
            <button
              type="button"
              data-testid="room-controls-compact"
              disabled={busy}
              onClick={() => runCommand("compact")}
              style={btnStyle}
              title="Compact session history"
            >
              Compact
            </button>
          </div>
          <label style={{ color: CASTLE.muted, fontSize: 12 }}>
            Model
            <select
              data-testid="room-controls-model"
              value={currentModelValue}
              disabled={busy}
              onChange={(e) => handleModelChange(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                borderRadius: 4,
                border: `1px solid ${CASTLE.creamFaint}`,
                background: CASTLE.panel,
                color: CASTLE.cream,
                fontSize: 13,
                padding: "4px 6px",
              }}
            >
              <option value="">{agentInfo?.model ? `(config: ${agentInfo.model})` : "Default"}</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
