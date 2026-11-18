import { useState, useEffect, useCallback, createElement } from 'react';
import '../styles/town.css';
import { ColonySidebar } from './ColonySidebar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { SessionInfo } from './SessionInfo.tsx';
import type { AgentStatus, ModelOption } from './types.ts';


export function App() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [meetingTopics, setMeetingTopics] = useState<string[]>([]);
  const [mode, setMode] = useState<string>('plan');
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function fetchStatus() {
    fetch('/api/status')
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents ?? []);
        setMeetingTopics(data.meetingTopics ?? []);
      })
      .catch(() => {});
  }

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((data) => {
        setAgents(data.agents ?? []);
        setMeetingTopics(data.meetingTopics ?? []);
        if (data.agents?.length > 0) setSelectedAgent(data.agents[0].name);
      })
      .catch(() => {});

    fetch('/api/mode')
      .then((r) => r.json())
      .then((data) => { if (data.mode) setMode(data.mode); })
      .catch(() => {});

    fetch('/api/models')
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data.models)) setAvailableModels(data.models); })
      .catch(() => {});

    const statusInterval = setInterval(fetchStatus, 5000);
    const modelsInterval = setInterval(() => {
      fetch('/api/models')
        .then((r) => r.json())
        .then((data) => { if (Array.isArray(data.models)) setAvailableModels(data.models); })
        .catch(() => {});
    }, 10_000);

    return () => { clearInterval(statusInterval); clearInterval(modelsInterval); };
  }, []);

  const handleModeChange = useCallback((newMode: string) => {
    fetch('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: newMode }),
    })
      .then((r) => r.json())
      .then((data) => { if (data.mode) setMode(data.mode); })
      .catch(() => {});
  }, []);

  const handleModelChange = useCallback((agentName: string, modelValue: string) => {
    // modelValue = "providerId/modelId" — pass full value so handleSetConfig can split
    fetch(`/api/config/${agentName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelValue }),
    })
      .then((r) => r.json())
      .then(() => fetchStatus()) // refresh agent status to reflect new model + provider
      .catch(() => {});
  }, []);

  const handleRibbonCommand = useCallback((cmd: 'new' | 'compact') => {
    if (!selectedAgent) return;
    const endpoint = cmd === 'new' ? `/api/new/${selectedAgent}` : `/api/compact/${selectedAgent}`;
    fetch(endpoint, { method: 'POST' })
      .then(() => fetchStatus())
      .catch(() => {});
  }, [selectedAgent]);

  const handleSelectAgent = useCallback((name: string) => {
    setSelectedAgent(name);
    setSidebarOpen(false);
  }, []);

  return createElement('div', { className: 'agent-town' },
    // Mobile hamburger
    createElement('button', {
      className: 'mobile-menu-btn',
      onClick: () => setSidebarOpen(o => !o),
      'aria-label': 'Open sidebar',
    }, '☰'),
    // Sidebar backdrop (mobile only)
    sidebarOpen && createElement('div', {
      className: 'sidebar-backdrop',
      onClick: () => setSidebarOpen(false),
    }),
    createElement('a', {
      href: '/castle',
      style: {
        position: 'fixed', top: '12px', right: '18px', zIndex: 100,
        fontFamily: "'Cinzel', serif", fontSize: '11px', color: '#c9a84c',
        textDecoration: 'none', letterSpacing: '2px', padding: '6px 12px',
        border: '1px solid rgba(201,168,76,0.2)', background: 'rgba(10,5,20,0.85)',
        transition: 'all 0.2s',
      },
    }, '🏰 Castle'),
    createElement('a', {
      href: '/vn-assets',
      style: {
        position: 'fixed', top: '12px', right: '92px', zIndex: 100,
        fontFamily: "'Cinzel', serif", fontSize: '11px', color: '#c9a84c',
        textDecoration: 'none', letterSpacing: '2px', padding: '6px 12px',
        border: '1px solid rgba(201,168,76,0.2)', background: 'rgba(10,5,20,0.85)',
        transition: 'all 0.2s',
      },
    }, '🎨 Assets'),
    createElement(ColonySidebar, {
      agents,
      meetingTopics,
      selectedAgent,
      onSelectAgent: handleSelectAgent,
      loadingAgents,
      mobileOpen: sidebarOpen,
      mode,
      onModeChange: handleModeChange,
      availableModels,
      onModelChange: handleModelChange,
    }),
    createElement(ChatPanel, {
      selectedAgent,
      agents,
      mode,
      onRibbonCommand: handleRibbonCommand,
      onLoadingChange: setLoadingAgents,
    }),
    createElement(SessionInfo, {
      selectedAgent,
      agents,
      mode,
      onModeChange: handleModeChange,
      availableModels,
      onModelChange: handleModelChange,
    }),
  );
}
