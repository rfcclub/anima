export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  agent?: string;
  streaming?: boolean;
  loadingWord?: string;
  toolStatus?: string;
}

export type SSEEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

export const LOADING_WORDS = [
  'thinking', 'working', 'dancing', 'bursting', 'running', 'debugging',
  'pondering', 'scheming', 'brewing', 'noodling', 'cooking', 'plotting',
];

export function randomLoadingWord(): string {
  return LOADING_WORDS[Math.floor(Math.random() * LOADING_WORDS.length)] + '…';
}

export const TOOL_STATUS_MAP: Record<string, string> = {
  bash: 'running',
  read: 'reading file',
  grep: 'searching',
  glob: 'searching',
  write: 'writing file',
  edit: 'editing file',
  mesh_send: 'messaging',
  mesh_agents: 'checking mesh status',
  anima_remember: 'remembering',
  anima_recall: 'recalling',
  anima_forget: 'forgetting',
  anima_bootstrap: 'bootstrapping',
  anima_update: 'updating memory',
  anima_list_all: 'listing memory',
  anima_stats: 'checking memory stats',
  anima_diagnose: 'diagnosing memory',
  anima_export: 'exporting memory',
  anima_import: 'importing memory',
  anima_invalidate: 'invalidating memory',
  anima_triple_add: 'recording knowledge',
  anima_triple_query: 'querying knowledge',
  anima_scratchpad_write: 'writing scratchpad',
  anima_scratchpad_read: 'reading scratchpad',
  anima_scratchpad_clear: 'clearing scratchpad',
  anima_context_search: 'searching context',
  anima_context_describe: 'describing context',
  anima_context_expand: 'expanding context',
  anima_memory_list: 'listing memory',
  anima_agent_status: 'checking agent status',
  anima_sleep: 'sleeping',
  anima_tool_list: 'listing tools',
  lcm_grep: 'searching',
};

export function contextualStatus(name: string, summary: string): string {
  const phrase = TOOL_STATUS_MAP[name];
  if (!phrase) return randomLoadingWord();
  if (summary && summary !== name) return `${phrase} — ${summary}…`;
  return `${phrase}…`;
}

export function applyStreamEvent(messages: ChatMessage[], event: SSEEvent): ChatMessage[] {
  const updated = [...messages];
  const lastIdx = updated.length - 1;
  const last = updated[lastIdx];
  if (!last?.streaming) return messages;

  const next: ChatMessage = { ...last };
  switch (event.kind) {
    case 'text':
      next.content += event.text;
      next.toolStatus = undefined;
      updated[lastIdx] = next;
      return updated;
    case 'tool_use':
      next.toolStatus = contextualStatus(event.name, event.summary);
      updated[lastIdx] = next;
      return updated;
    case 'error':
      next.content = event.message;
      next.streaming = false;
      next.toolStatus = undefined;
      updated[lastIdx] = next;
      return updated;
    case 'done':
      next.toolStatus = undefined;
      if (!next.content) {
        updated.pop();
        return updated;
      }
      next.streaming = false;
      updated[lastIdx] = next;
      return updated;
  }
}
