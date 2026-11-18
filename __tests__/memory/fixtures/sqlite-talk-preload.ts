import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { AnthropicProvider } from "../../../src/providers/anthropic";

// Exercise the real CLI without invoking a model or making network requests.
AnthropicProvider.prototype.query = async () => ({ message: { role: "assistant", content: "local mock" } });
globalThis.fetch = async () => { throw new Error("network disabled for test"); };

for (const method of ["run", "exec"] as const) {
  const original = Database.prototype[method];
  (Database.prototype as any)[method] = function(this: Database, sql: string, ...bindings: unknown[]) {
    if (this.filename === process.env.ANIMA_SESSIONS_DB && /^PRAGMA\s+journal_mode\s*=\s*WAL/i.test(sql)) {
      writeFileSync(process.env.SQLITE_ATTEMPT_MARKER!, "about-to-configure-sessions");
    }
    return Reflect.apply(original, this, [sql, ...bindings]);
  };
}
