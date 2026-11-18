import type { GuardConfig } from "../app/origin-guard";
import type { AgentLoader } from "../../agents/loader";
import type { SessionManager } from "../../session/manager";
import type { MeetingRoom } from "../../meeting/room";
import type { Provider } from "../../providers/interface";

export interface AgentStatus {
  name: string;
  label: string;
  status: "online" | "busy" | "offline";
  turnCount: number;
  model?: string;
  provider?: string;
}

export interface StatusResponse {
  agents: AgentStatus[];
  meetingTopics: string[];
}

export interface SessionResponse {
  sessionId: string;
  turnCount: number;
  estimatedTokens: number;
  hasBaseline: boolean;
  unreadMailCount: number;
}

export interface ModeResponse {
  mode: string;
}

export interface UIServerDeps {
  /** Override rooms directory (default: ANIMA_ROOMS_DIR or ~/.anima/rooms) */
  roomsDir?: string;
  /** Override state directory (default: ANIMA_UI_STATE_DIR or ~/.anima) */
  stateDir?: string;
  /** Map of agent name → Provider for testing / injection */
  providers?: Map<string, Provider>;
  /** Injected deps for testing */
  agentLoader?: AgentLoader;
  sessionManager?: SessionManager;
  meetingRoom?: MeetingRoom;
  /** Origin guard config (default: loopback origins of ANIMA_UI_PORT plus ANIMA_UI_ALLOWED_ORIGINS) */
  guard?: GuardConfig;
}

export interface ModelOption {
  value: string;  // "providerId/modelId"
  label: string;  // "Provider — modelId"
  providerId: string;
  modelId: string;
}
