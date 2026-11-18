import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

/** Simple subsequence fuzzy match; returns a score (lower = better) or null. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === "") return 0;
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += last === -1 ? found : found - last - 1;
    last = found;
    ti = found + 1;
  }
  return score;
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
      .filter((m): m is { c: PaletteCommand; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((m) => m.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setSelected(0), [query]);

  if (!open) return null;

  const run = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-24"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={onClose}
    >
      <div
        className="w-[480px] overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: "var(--panel)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown")
              setSelected((s) => Math.min(s + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter") run(matches[selected]);
          }}
          placeholder="Type a command…"
          className="w-full border-b px-4 py-3 text-sm outline-none"
          style={{
            background: "var(--panel)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
        />
        <div className="max-h-72 overflow-y-auto py-1">
          {matches.length === 0 && (
            <div className="px-4 py-3 text-sm" style={{ color: "var(--muted)" }}>
              No matching commands
            </div>
          )}
          {matches.map((cmd, i) => (
            <button
              key={cmd.id}
              onClick={() => run(cmd)}
              onMouseEnter={() => setSelected(i)}
              className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm"
              style={{
                background: i === selected ? "var(--accent-dim)" : "transparent",
                color: i === selected ? "var(--accent)" : "var(--text)",
              }}
            >
              <span>{cmd.label}</span>
              {cmd.hint && (
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {cmd.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
