// ---------------------------------------------------------------------------
// AgentTheme — per-agent visual novel stage theming
// ---------------------------------------------------------------------------

import type { AgentMood } from "./agent-response";

export type PortraitPosition = "left" | "center" | "right";

export interface AgentTheme {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
  };
  fontStyle: string;
  defaultMood: AgentMood;
  portraitPosition: PortraitPosition;
}
