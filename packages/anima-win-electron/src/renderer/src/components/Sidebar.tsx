export type ViewId = "overview" | "entities" | "settings";

const NAV: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "◉" },
  { id: "entities", label: "Entities", icon: "❖" },
];

interface Props {
  active: ViewId;
  onSelect: (id: ViewId) => void;
}

export function Sidebar({ active, onSelect }: Props) {
  const item = (id: ViewId, label: string, icon: string) => {
    const isActive = active === id;
    return (
      <button
        key={id}
        onClick={() => onSelect(id)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors"
        style={{
          background: isActive ? "var(--accent-dim)" : "transparent",
          borderColor: isActive ? "var(--border)" : "transparent",
          color: isActive ? "var(--accent)" : "var(--muted)",
        }}
      >
        <span className="w-5 text-center text-base leading-none">{icon}</span>
        <span className="font-medium">{label}</span>
      </button>
    );
  };

  return (
    <nav
      className="flex h-full w-52 flex-col gap-1 border-r p-2"
      style={{ background: "var(--panel)", borderColor: "var(--border)" }}
    >
      <div className="mb-2 flex items-center gap-2 px-2 py-2" style={{ color: "var(--accent)" }}>
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg border text-sm font-bold"
          style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
        >
          A
        </span>
        <span className="text-sm font-semibold tracking-wide">ANIMA</span>
      </div>

      {NAV.map((n) => item(n.id, n.label, n.icon))}
      <div className="flex-1" />
      {item("settings", "Settings", "⚙")}
    </nav>
  );
}
