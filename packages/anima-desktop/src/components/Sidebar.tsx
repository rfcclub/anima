import type { ViewId } from "../lib/settings";

export type NavId = ViewId | "settings";

const NAV: Array<{ id: NavId; label: string; icon: string; shortcut?: string }> = [
  { id: "town", label: "Town", icon: "🏘", shortcut: "1" },
  { id: "openclaw", label: "OpenClaw", icon: "🦞", shortcut: "2" },
  { id: "chat", label: "Chat", icon: "💬", shortcut: "3" },
];

interface Props {
  active: NavId;
  collapsed: boolean;
  onSelect: (id: NavId) => void;
  onToggleCollapse: () => void;
}

export function Sidebar({ active, collapsed, onSelect, onToggleCollapse }: Props) {
  const item = (id: NavId, label: string, icon: string, shortcut?: string) => {
    const isActive = active === id;
    return (
      <button
        key={id}
        onClick={() => onSelect(id)}
        title={collapsed ? label : undefined}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm"
        style={{
          background: isActive ? "var(--accent-dim)" : "transparent",
          borderColor: isActive ? "var(--border)" : "transparent",
          color: isActive ? "var(--accent)" : "var(--muted)",
        }}
      >
        <span className="text-base leading-none">{icon}</span>
        {!collapsed && <span className="flex-1 font-medium">{label}</span>}
        {!collapsed && shortcut && (
          <kbd
            className="rounded border px-1.5 py-0.5 text-[10px]"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            ⌘{shortcut}
          </kbd>
        )}
      </button>
    );
  };

  return (
    <nav
      className="flex h-full flex-col gap-1 border-r p-2"
      style={{
        width: collapsed ? 60 : 200,
        background: "var(--panel)",
        borderColor: "var(--border)",
      }}
    >
      <div
        className="mb-2 flex items-center gap-2 px-2 py-2"
        style={{ color: "var(--accent)" }}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-sm font-bold"
          style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
        >
          A
        </span>
        {!collapsed && <span className="text-sm font-semibold tracking-wide">ANIMA</span>}
      </div>

      {NAV.map((n) => item(n.id, n.label, n.icon, n.shortcut))}

      <div className="flex-1" />

      <button
        onClick={onToggleCollapse}
        className="cursor-pointer rounded-lg px-3 py-2 text-left text-xs"
        style={{ color: "var(--muted)" }}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "»" : "« Collapse"}
      </button>

      {item("settings", "Settings", "⚙")}
    </nav>
  );
}
