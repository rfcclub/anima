export interface ModelOption {
  value: string;      // "providerId/modelId"
  label: string;      // "Provider — modelId"
  providerId: string;
  modelId: string;
}

export interface AgentStatus {
  name: string;
  label: string;
  status: 'online' | 'busy' | 'offline';
  turnCount: number;
  model?: string;
  provider?: string;
}

export interface SessionResponse {
  sessionId: string;
  turnCount: number;
  estimatedTokens: number;
  hasBaseline: boolean;
  unreadMailCount: number;
}

/** Agent identity colours */
export const AGENT_COLORS: Record<string, string> = {
  bruno: '#e94560',
  eli: '#00d2ff',
  milo: '#bb86fc',
  sam: '#f0883e',
  cleo: '#3fb950',
  lena: '#ffd700',
  ivan: '#8b949e',
};

export function agentColor(name: string): string {
  return AGENT_COLORS[name.toLowerCase()] ?? '#8b949e';
}
