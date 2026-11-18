import { useState, useEffect, createElement } from 'react';
import type { AgentStatus, ModelOption, SessionResponse } from './types.ts';

interface SessionInfoProps {
  selectedAgent: string | null;
  agents: AgentStatus[];
  mode: string;
  onModeChange: (mode: string) => void;
  availableModels: ModelOption[];
  onModelChange: (agentName: string, modelValue: string) => void;
}

interface BranchInfo {
  id: number;
  name: string;
  parentBranchId: number | null;
  forkFromTurnId: number | null;
  isActive: boolean;
}

interface NarrativeChoice {
  id: string;
  label: string;
  value: string;
  turnId: number;
  timestamp: string;
}

const MODES = ['plan', 'edit', 'auto'];

export function SessionInfo(props: SessionInfoProps) {
  const { selectedAgent, agents, mode, onModeChange, availableModels, onModelChange } = props;
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [choices, setChoices] = useState<NarrativeChoice[]>([]);
  const [showBranches, setShowBranches] = useState(false);
  const [switchWarning, setSwitchWarning] = useState<string | null>(null);
  const [pendingBranchId, setPendingBranchId] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedAgent) { setSession(null); setBranches([]); setChoices([]); return; }
    function fetchSession() {
      fetch(`/api/session/${selectedAgent}`)
        .then((r) => r.json())
        .then((data) => setSession(data as SessionResponse))
        .catch(() => {});
    }
    function fetchBranches() {
      fetch(`/api/vn/choices/${selectedAgent}`)
        .then((r) => r.json())
        .then((data) => {
          setBranches((data.branches as BranchInfo[]) ?? []);
          setChoices((data.choices as NarrativeChoice[]) ?? []);
        })
        .catch(() => {});
    }
    fetchSession();
    fetchBranches();
    const interval = setInterval(() => { fetchSession(); fetchBranches(); }, 5000);
    return () => clearInterval(interval);
  }, [selectedAgent]);

  function requestSwitch(branchId: number) {
    if (!selectedAgent || !session) return;
    fetch('/api/vn/switch-branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, branchId }),
    })
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        if (d.warning) {
          setSwitchWarning(d.message as string);
          setPendingBranchId(branchId);
        } else if (d.ok) {
          // Refresh branches to show new active state
          fetch(`/api/vn/choices/${selectedAgent}`)
            .then((r) => r.json())
            .then((data) => setBranches((data.branches as BranchInfo[]) ?? []))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  function confirmSwitch() {
    if (!selectedAgent || !session || !pendingBranchId) return;
    const bid = pendingBranchId;
    setPendingBranchId(null);
    setSwitchWarning(null);
    fetch('/api/vn/switch-branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId, branchId: bid, confirmed: true }),
    })
      .then((r) => r.json())
      .then(() => {
        fetch(`/api/vn/choices/${selectedAgent}`)
          .then((r) => r.json())
          .then((data) => setBranches((data.branches as BranchInfo[]) ?? []))
          .catch(() => {});
      })
      .catch(() => {});
  }

  if (!selectedAgent) {
    return createElement('div', { className: 'session-info' },
      createElement('div', { className: 'empty-state' },
        createElement('div', { className: 'empty-state-icon' }, '\u2139\ufe0f'),
        createElement('div', { className: 'empty-state-text' }, 'Select an agent'),
      ),
    );
  }

  const agentInfo = agents.find(a => a.name === selectedAgent);
  const currentModelValue = availableModels.find(m => m.modelId === agentInfo?.model)?.value ?? '';

  const stats = session
    ? [
        { label: 'Session', value: session.sessionId.slice(0, 8) + '…' },
        { label: 'Turns', value: String(session.turnCount) },
        { label: 'Est. Tokens', value: String(session.estimatedTokens) },
        { label: 'Baseline', value: session.hasBaseline ? 'Yes' : 'No' },
        { label: 'Unread Mail', value: String(session.unreadMailCount) },
      ]
    : [];

  // Branch panel elements
  const branchElements: ReturnType<typeof createElement>[] = [];

  // Toggle button
  branchElements.push(
    createElement('button', {
      key: 'branch-toggle',
      className: 'branch-toggle-btn',
      onClick: () => setShowBranches(!showBranches),
      title: 'Narrative branches',
    }, `🌿 Branches (${branches.length})`),
  );

  if (showBranches && branches.length > 0) {
    const branchItems = branches.map((b) => {
      const isActive = b.isActive;
      return createElement('div', {
        key: b.id,
        className: 'branch-item' + (isActive ? ' active' : ''),
        onClick: () => { if (!isActive) requestSwitch(b.id); },
        title: isActive ? 'Current branch' : 'Click to switch',
      },
        createElement('div', { className: 'branch-item-name' },
          (isActive ? '▸ ' : '') + b.name,
        ),
        createElement('div', { className: 'branch-item-detail' },
          b.forkFromTurnId ? `fork at turn ${b.forkFromTurnId}` : 'root',
          b.parentBranchId ? ` · child of #${b.parentBranchId}` : '',
        ),
      );
    });

    branchElements.push(
      createElement('div', { key: 'branch-list', className: 'branch-list' }, ...branchItems),
    );

    // Choice history
    if (choices.length > 0) {
      branchElements.push(
        createElement('div', { key: 'choice-label', className: 'branch-choice-label' }, 'Choices'),
      );
      choices.forEach((c) => {
        branchElements.push(
          createElement('div', { key: c.id, className: 'branch-choice-item' },
            createElement('span', { className: 'br-choice-label' }, c.label),
            createElement('span', { className: 'br-choice-turn' }, `T${c.turnId}`),
          ),
        );
      });
    }
  }

  // Warning modal
  const warningModal = switchWarning
    ? createElement('div', { className: 'branch-warning-overlay', onClick: () => { setSwitchWarning(null); setPendingBranchId(null); } },
        createElement('div', { className: 'branch-warning-modal', onClick: (e: Event) => e.stopPropagation() },
          createElement('h3', null, 'Switch Branch?'),
          createElement('p', null, switchWarning),
          createElement('div', { className: 'branch-warning-btns' },
            createElement('button', { key: 'confirm', onClick: confirmSwitch }, 'Switch'),
            createElement('button', { key: 'cancel', onClick: () => { setSwitchWarning(null); setPendingBranchId(null); } }, 'Cancel'),
          ),
        ),
      )
    : null;

  return createElement('div', { className: 'session-info' },
    createElement('h3', null, `${selectedAgent}`),
    ...stats.map((s) =>
      createElement('div', { key: s.label, className: 'session-stat' },
        createElement('span', { className: 'session-stat-label' }, s.label),
        createElement('span', { className: 'session-stat-value' }, s.value),
      ),
    ),
    createElement('div', { className: 'mode-selector' },
      createElement('label', null, 'Mode'),
      createElement('select', {
        value: mode,
        onChange: (e: Event) => onModeChange((e.target as HTMLSelectElement).value),
      },
        ...MODES.map(m => createElement('option', { key: m, value: m }, m)),
      ),
    ),
    createElement('div', { className: 'mode-selector' },
      createElement('label', null, 'Model'),
      createElement('select', {
        value: currentModelValue,
        onChange: (e: Event) => {
          const val = (e.target as HTMLSelectElement).value;
          if (val && selectedAgent) onModelChange(selectedAgent, val);
        },
      },
        createElement('option', { value: '' }, agentInfo?.model ? `(config: ${agentInfo.model})` : 'Default'),
        ...availableModels.map(opt =>
          createElement('option', { key: opt.value, value: opt.value }, opt.label),
        ),
      ),
    ),
    ...branchElements,
    warningModal,
  );
}
