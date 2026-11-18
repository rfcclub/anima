import { useState, useRef, useEffect, createElement } from 'react';
import { agentColor } from './types.ts';
import type { AgentStatus } from './types.ts';
import { applyStreamEvent, randomLoadingWord, type ChatMessage } from '../lib/streamReducer';

interface ChatPanelProps {
  selectedAgent: string | null;
  agents: AgentStatus[];
  mode: string;
  onRibbonCommand: (cmd: 'new' | 'compact') => void;
  onLoadingChange?: (loadingAgents: Set<string>) => void;
}

interface HistoryTurn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

type ThinkLevel = 'off' | 'low' | 'medium' | 'high';
type EffortLevel = 'fast' | 'normal' | 'deep';

const THINK_CYCLE: ThinkLevel[] = ['off', 'low', 'medium', 'high'];
const EFFORT_CYCLE: EffortLevel[] = ['normal', 'fast', 'deep'];
const THINK_LABEL: Record<ThinkLevel, string> = { off: 'Think', low: 'Think:L', medium: 'Think:M', high: 'Think:H' };
const EFFORT_LABEL: Record<EffortLevel, string> = { normal: 'Effort', fast: 'Effort:F', deep: 'Effort:D' };

export function ChatPanel(props: ChatPanelProps) {
  const { selectedAgent, agents, mode, onRibbonCommand, onLoadingChange } = props;
  const [allMessages, setAllMessages] = useState<Map<string, ChatMessage[]>>(() => new Map());
  const [input, setInput] = useState('');
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(() => new Set());
  const [thinking, setThinking] = useState<ThinkLevel>('off');
  const [effort, setEffort] = useState<EffortLevel>('normal');
  const [showHistory, setShowHistory] = useState(false);
  const [historyTurns, setHistoryTurns] = useState<HistoryTurn[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());
  const pendingRef = useRef<Map<string, string>>(new Map());
  const [pendingAgents, setPendingAgents] = useState<Set<string>>(() => new Set());

  const messages = allMessages.get(selectedAgent ?? '') ?? [];
  const isCurrentAgentLoading = selectedAgent ? loadingAgents.has(selectedAgent) : false;

  useEffect(() => {
    onLoadingChange?.(loadingAgents);
  }, [loadingAgents, onLoadingChange]);

  function setAgentLoading(agent: string, loading: boolean) {
    setLoadingAgents(prev => {
      const next = new Set(prev);
      if (loading) next.add(agent); else next.delete(agent);
      return next;
    });
  }

  function updateMessages(agent: string, updater: (prev: ChatMessage[]) => ChatMessage[]) {
    setAllMessages(prev => {
      const next = new Map(prev);
      next.set(agent, updater(next.get(agent) ?? []));
      return next;
    });
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!selectedAgent) return;
    const existing = allMessages.get(selectedAgent);
    if (existing && existing.length > 0) return;
    // Load the most recent turns, not the oldest. /api/history paginates
    // id ASC LIMIT n OFFSET offset, so to get the newest window we ask for
    // the last page: offset = max(0, total - n). Otherwise Town shows the
    // first 40 turns (old) while Castle's /api/turns shows the last 100
    // (recent) — same session, divergent context, which reads as a split.
    const N = 40;
    fetch(`/api/history/${selectedAgent}?n=1&offset=0`)
      .then(r => r.ok ? r.json() : null)
      .then((probe: { total: number } | null) => {
        const total = probe?.total ?? 0;
        const offset = Math.max(0, total - N);
        return fetch(`/api/history/${selectedAgent}?n=${N}&offset=${offset}`);
      })
      .then(r => r.ok ? r.json() : null)
      .then((data: { turns: HistoryTurn[]; total: number } | null) => {
        if (!data || data.turns.length === 0) return;
        const restored: ChatMessage[] = data.turns.map(t => ({
          role: t.role,
          content: t.content,
          agent: t.role === 'assistant' ? selectedAgent : undefined,
        }));
        updateMessages(selectedAgent!, prev => prev.length > 0 ? prev : restored);
      })
      .catch(() => {});
  }, [selectedAgent]);

  // Auto-send pending message when agent finishes loading
  useEffect(() => {
    for (const agent of Array.from(pendingAgents)) {
      if (!loadingAgents.has(agent)) {
        const msg = pendingRef.current.get(agent);
        if (msg) {
          pendingRef.current.delete(agent);
          setPendingAgents(prev => { const s = new Set(prev); s.delete(agent); return s; });
          startFetch(agent, msg);
        }
      }
    }
  }, [loadingAgents]);

  // ── Per-agent non-blocking SSE reader ──────────────────────────────
  async function consumeSSE(
    agent: string,
    response: Response,
    abort: AbortController,
  ) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') {
            updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'done' }));
            setAgentLoading(agent, false);
            continue;
          }
          try {
            const parsed = JSON.parse(payload);
            if (typeof parsed === 'string') {
              updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'text', text: parsed }));
            } else if (parsed?.type === 'tool_use') {
              updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'tool_use', name: parsed.name, summary: parsed.summary }));
            } else if (parsed?.error) {
              updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'error', message: `Error: ${parsed.error}` }));
              setAgentLoading(agent, false);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'error', message: 'Connection error' }));
      setAgentLoading(agent, false);
    }
  }

  // ── Core fetch + stream for a single agent message ────────────────
  async function startFetch(agent: string, msg: string) {
    const existingAbort = abortRefs.current.get(agent);
    if (existingAbort) existingAbort.abort();

    setAgentLoading(agent, true);
    updateMessages(agent, prev => [...prev, { role: 'user', content: msg }]);
    updateMessages(agent, prev => [...prev, { role: 'assistant', content: '', agent, streaming: true, loadingWord: randomLoadingWord() }]);

    try {
      const abort = new AbortController();
      abortRefs.current.set(agent, abort);
      const body: Record<string, unknown> = { message: msg, mode };
      if (thinking !== 'off') body.thinking = { budget: thinking };
      if (effort !== 'normal') body.effort = effort;

      const res = await fetch(`/api/talk/${agent}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) {
        updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'error', message: `Error: ${res.status}` }));
        setAgentLoading(agent, false);
        return;
      }
      await consumeSSE(agent, res, abort);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setAgentLoading(agent, false);
    } finally {
      abortRefs.current.delete(agent);
    }
  }

  // ── Send message — queues if agent is busy ─────────────────────────
  async function sendMessage(overrideMsg?: string) {
    const msg = (overrideMsg ?? input).trim();
    if (!msg || !selectedAgent) return;
    if (!overrideMsg) setInput('');
    const agent = selectedAgent;

    if (loadingAgents.has(agent)) {
      pendingRef.current.set(agent, msg);
      setPendingAgents(prev => new Set([...prev, agent]));
      return;
    }

    startFetch(agent, msg);
  }

  // ── Stream command (per-agent, non-blocking) ───────────────────────
  async function streamCommand(agent: string, endpoint: string) {
    if (!agent || loadingAgents.has(agent)) return;

    const existingAbort = abortRefs.current.get(agent);
    if (existingAbort) existingAbort.abort();

    setAgentLoading(agent, true);
    updateMessages(agent, prev => [...prev, { role: 'assistant', content: '', agent, streaming: true, loadingWord: randomLoadingWord() }]);

    try {
      const abort = new AbortController();
      abortRefs.current.set(agent, abort);
      const res = await fetch(endpoint, { method: 'POST', signal: abort.signal });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as Record<string, unknown>;
        updateMessages(agent, prev => applyStreamEvent(prev, { kind: 'error', message: `Error: ${errData.error ?? res.status}` }));
        setAgentLoading(agent, false);
        return;
      }
      await consumeSSE(agent, res, abort);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setAgentLoading(agent, false);
    } finally {
      abortRefs.current.delete(agent);
    }
  }

  async function handleRetry() {
    if (!selectedAgent || isCurrentAgentLoading) return;
    const agent = selectedAgent;
    updateMessages(agent, prev => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === 'assistant') { updated.splice(i, 1); break; }
      }
      return updated;
    });
    await streamCommand(agent, `/api/retry/${agent}`);
  }

  async function handleBack() {
    if (!selectedAgent || isCurrentAgentLoading) return;
    const agent = selectedAgent;
    const res = await fetch(`/api/back/${agent}`, { method: 'POST' });
    if (res.ok) {
      updateMessages(agent, prev => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'assistant') { updated.splice(i, 1); break; }
        }
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'user') { updated.splice(i, 1); break; }
        }
        return updated;
      });
    }
  }

  async function handleHistory(loadMore = false) {
    if (!selectedAgent) return;
    const offset = loadMore ? historyOffset : 0;
    if (!loadMore) { setHistoryTurns([]); setHistoryOffset(0); }
    const res = await fetch(`/api/history/${selectedAgent}?n=20&offset=${offset}`);
    if (!res.ok) return;
    const data = await res.json() as { turns: HistoryTurn[]; total: number; hasMore: boolean };
    setHistoryTurns(prev => loadMore ? [...prev, ...data.turns] : data.turns);
    setHistoryTotal(data.total);
    setHistoryOffset(offset + data.turns.length);
    setShowHistory(true);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // ── Copy message to clipboard ──────────────────────────────────────
  function copyMessage(msgId: string, content: string) {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(msgId);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {});
  }

  function handleRibbon(cmd: string) {
    if (!selectedAgent) return;
    switch (cmd) {
      case 'clear':
        updateMessages(selectedAgent, () => []);
        return;
      case 'new':
        setThinking('off');
        setEffort('normal');
        setShowHistory(false);
        sendMessage('/new');
        return;
      case 'compact':
        sendMessage('/compact');
        return;
      case 'think': {
        const idx = THINK_CYCLE.indexOf(thinking);
        setThinking(THINK_CYCLE[(idx + 1) % THINK_CYCLE.length]);
        return;
      }
      case 'effort': {
        const idx = EFFORT_CYCLE.indexOf(effort);
        setEffort(EFFORT_CYCLE[(idx + 1) % EFFORT_CYCLE.length]);
        return;
      }
      case 'export':
        window.open(`/api/export/${selectedAgent}`, '_blank');
        return;
      case 'summary':
        sendMessage('/summary');
        return;
      case 'review':
        sendMessage('/review');
        return;
      case 'retry':
        handleRetry();
        return;
      case 'back':
        handleBack();
        return;
      case 'history':
        if (showHistory) { setShowHistory(false); } else { handleHistory(); }
        return;
    }
  }

  const agentInfo = agents.find(a => a.name === selectedAgent);
  const color = selectedAgent ? agentColor(selectedAgent) : undefined;
  const modelText = agentInfo?.provider && agentInfo?.model
    ? `${agentInfo.provider} — ${agentInfo.model}`
    : agentInfo?.model ?? '';

  const isAnthropicAgent = agentInfo?.provider === 'anthropic';
  const hasMessages = messages.some(m => m.role === 'user' || m.role === 'assistant');

  const RIBBON_DEFS = [
    { cmd: 'retry', label: 'Retry', title: 'Regenerate last response', disabled: !hasMessages },
    { cmd: 'summary', label: 'Summary', title: 'Summarize conversation', disabled: false },
    { cmd: 'review', label: 'Review', title: 'Self-review last response', disabled: !hasMessages },
    { cmd: 'history', label: 'History', title: 'Show session history', disabled: false, active: showHistory },
    { cmd: 'back', label: 'Back', title: 'Undo last exchange', disabled: !hasMessages },
    { cmd: 'new', label: 'New', title: 'Start new session', disabled: false },
    { cmd: 'compact', label: 'Compact', title: 'Compact session history', disabled: false },
    { cmd: 'clear', label: 'Clear', title: 'Clear chat view (local only)', disabled: false },
    {
      cmd: 'think',
      label: THINK_LABEL[thinking],
      title: isAnthropicAgent ? 'Extended thinking (Claude only)' : 'Extended thinking requires Claude',
      disabled: !isAnthropicAgent,
      active: thinking !== 'off',
      variant: 'think',
    },
    {
      cmd: 'effort',
      label: EFFORT_LABEL[effort],
      title: 'Response effort tier',
      disabled: false,
      active: effort !== 'normal',
      variant: 'effort',
    },
    { cmd: 'export', label: 'Export', title: 'Export conversation as markdown', disabled: false },
  ];

  const ribbonBtns = RIBBON_DEFS.map(({ cmd, label, title, disabled, active, variant }) => {
    const classes = [
      'ribbon-btn',
      active ? 'active' : '',
      variant === 'think' && active ? 'think-active' : '',
      variant === 'effort' && active ? 'effort-active' : '',
    ].filter(Boolean).join(' ');
    return createElement('button', {
      key: cmd,
      className: classes,
      title,
      disabled: !selectedAgent || disabled,
      onClick: () => handleRibbon(cmd),
    }, label);
  });

  // ── Message rendering with copy buttons ────────────────────────────
  const messageElements = messages.map((msg, i) => {
    const msgId = `${selectedAgent}-${i}`;

    const classes = `chat-message ${msg.role}${msg.streaming ? ' streaming' : ''}`;
    const style = msg.role === 'assistant' && msg.agent
      ? { borderLeft: `3px solid ${agentColor(msg.agent)}` }
      : undefined;

    // Build content: show a playful loading word when streaming with empty
    // content. Tool activity is a separate line below the bubble — it never
    // replaces this text.
    let displayContent = msg.content;
    if (msg.streaming && !msg.content) {
      displayContent = msg.loadingWord ?? 'thinking…';
    }

    // Copy button (only on non-streaming messages with content)
    const copyBtn = !msg.streaming && msg.content
      ? createElement('button', {
          className: 'msg-copy-btn' + (copiedId === msgId ? ' copied' : ''),
          title: 'Copy to clipboard',
          onClick: (e: Event) => { e.stopPropagation(); copyMessage(msgId, msg.content); },
        }, copiedId === msgId ? '✓' : '📋')
      : null;

    const toolLine = msg.toolStatus
      ? createElement('div', { className: 'chat-message tool-call' },
          createElement('span', { className: 'tool-call-icon' }, '🔧'),
          createElement('span', { className: 'tool-call-name' }, msg.toolStatus),
        )
      : null;

    return createElement('div', { key: i, className: classes, style },
      msg.agent
        ? createElement('div', { className: 'msg-agent-label', style: { color: agentColor(msg.agent) } }, msg.agent)
        : null,
      createElement('div', { className: 'msg-body' },
        createElement('div', { className: 'msg-content' }, displayContent),
        copyBtn,
      ),
      toolLine,
    );
  });

  const historyPanel = showHistory
    ? createElement('div', { className: 'history-panel' },
        createElement('div', { className: 'history-header' },
          createElement('span', null, `History (${historyTotal} turns)`),
          createElement('button', { className: 'history-close', onClick: () => setShowHistory(false) }, '×'),
        ),
        ...historyTurns.map((t, i) =>
          createElement('div', { key: i, className: `history-row ${t.role}` },
            createElement('span', { className: 'history-role' }, t.role === 'user' ? '👤' : '🤖'),
            createElement('span', { className: 'history-content' }, t.content.slice(0, 100) + (t.content.length > 100 ? '…' : '')),
            createElement('span', { className: 'history-ts' }, new Date(t.ts).toLocaleTimeString()),
          ),
        ),
        historyOffset < historyTotal
          ? createElement('button', {
              className: 'history-load-more',
              onClick: () => handleHistory(true),
            }, 'Load More')
          : null,
      )
    : null;

  const textareaEl = createElement('textarea', {
    className: 'chat-input',
    placeholder: selectedAgent ? `Message ${selectedAgent}… (Enter send, Shift+Enter newline)` : 'Select an agent',
    value: input,
    rows: 2,
    disabled: !selectedAgent,
    onChange: (e: Event) => setInput((e.target as HTMLTextAreaElement).value),
    onKeyDown: handleKeyDown,
  });

  const isQueued = selectedAgent ? pendingAgents.has(selectedAgent) : false;
  const sendBtn = createElement('button', {
    className: 'chat-send-btn',
    disabled: !selectedAgent || !input.trim(),
    onClick: sendMessage,
    style: { background: color },
  }, isCurrentAgentLoading ? (isQueued ? '⏳' : '…') : 'Send');

  const modelBadge = modelText
    ? createElement('span', { className: 'model-badge' }, modelText)
    : null;

  return createElement('div', { className: 'chat-panel' },
    createElement('div', { className: 'chat-header', style: color ? { borderBottomColor: color } : undefined },
      createElement('span', null, selectedAgent ? `Chat — ${selectedAgent}` : 'Agent Town'),
      modelBadge,
    ),
    createElement('div', { className: 'chat-ribbon' }, ...ribbonBtns),
    historyPanel,
    createElement('div', { className: 'chat-messages' },
      messages.length === 0
        ? createElement('div', { className: 'empty-state' },
            createElement('div', { className: 'empty-state-icon' }, '💬'),
            createElement('div', { className: 'empty-state-text' },
              selectedAgent ? `Send a message to ${selectedAgent} to start` : 'Select an agent',
            ),
          )
        : null,
      ...messageElements,
      createElement('div', { ref: messagesEndRef }),
    ),
    createElement('div', { className: 'chat-input-area' }, textareaEl, sendBtn),
  );
}
