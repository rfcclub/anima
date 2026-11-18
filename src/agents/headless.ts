import type { RoomConfig } from "../config/types";
import { NullMemoryAdapter } from "../memory/null-adapter";
import type { LoadedAgent } from "./loader";

/** A runtime descriptor made from configuration only; it never loads the agent's substrate. */
export function headlessAgent(identity: { name: string; label: string }, config: RoomConfig, roomDir: string): LoadedAgent {
  return {
    name: identity.name,
    label: identity.label,
    roomDir,
    config,
    geneContent: "",
    sessionContextFiles: [],
    additionalContent: [],
    memoryAdapter: new NullMemoryAdapter(),
  };
}
