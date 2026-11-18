import { createElement } from 'react';
import { agentColor } from './types.ts';
import type { AgentStatus, ModelOption } from './types.ts';

const MODES = ['plan', 'edit', 'auto'];

interface ColonySidebarProps {
  agents: AgentStatus[];
  meetingTopics: string[];
  selectedAgent: string | null;
  onSelectAgent: (name: string) => void;
  loadingAgents?: Set<string>;
  mobileOpen?: boolean;
  // mobile settings
  mode?: string;
  onModeChange?: (mode: string) => void;
  availableModels?: ModelOption[];
  onModelChange?: (agentName: string, modelValue: string) => void;
}

export function ColonySidebar(props: ColonySidebarProps) {
  const {
    agents, meetingTopics, selectedAgent, onSelectAgent, loadingAgents, mobileOpen,
    mode, onModeChange, availableModels, onModelChange,
  } = props;

  const agentInfo = agents.find(a => a.name === selectedAgent);
  const currentModelValue = availableModels?.find(m => m.modelId === agentInfo?.model)?.value ?? '';

  const agentList = agents.map((agent) => {
    const color = agentColor(agent.name);
    const isSelected = agent.name === selectedAgent;
    const isLoading = loadingAgents?.has(agent.name) ?? false;

    return createElement(
      'li',
      {
        key: agent.name,
        className: `agent-item${isSelected ? ' selected' : ''}`,
        onClick: () => onSelectAgent(agent.name),
      },
      createElement('div', { className: 'agent-color-bar', style: { background: color } }),
      createElement('div', { className: `status-dot ${isLoading ? 'agent-loading' : agent.status}` }),
      createElement('span', { className: 'agent-name' }, agent.name),
      createElement('span', { className: 'agent-label' }, isLoading ? '···' : agent.label),
    );
  });

  const topicItems = meetingTopics.map((topic) =>
    createElement('li', { key: topic, className: 'meeting-topic-item' }, topic),
  );

  const mobileSettings = createElement('div', { className: 'sidebar-mobile-settings' },
    createElement('div', { className: 'colony-sidebar-section' }, 'Settings'),
    createElement('div', { className: 'mode-selector' },
      createElement('label', null, 'Mode'),
      createElement('select', {
        value: mode ?? 'plan',
        onChange: (e: Event) => onModeChange?.((e.target as HTMLSelectElement).value),
      },
        ...MODES.map(m => createElement('option', { key: m, value: m }, m)),
      ),
    ),
    availableModels && availableModels.length > 0
      ? createElement('div', { className: 'mode-selector' },
          createElement('label', null, 'Model'),
          createElement('select', {
            value: currentModelValue,
            onChange: (e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val && selectedAgent) onModelChange?.(selectedAgent, val);
            },
          },
            createElement('option', { value: '' }, agentInfo?.model ? `(config: ${agentInfo.model})` : 'Default'),
            ...availableModels.map(opt =>
              createElement('option', { key: opt.value, value: opt.value }, opt.label),
            ),
          ),
        )
      : null,
  );

  return createElement('div', { className: `colony-sidebar${mobileOpen ? ' mobile-open' : ''}` },
    createElement('div', { className: 'colony-sidebar-header' }, 'Colony'),
    createElement('ul', { className: 'agent-list' }, ...agentList),
    meetingTopics.length > 0
      ? createElement(
          'div',
          null,
          createElement('div', { className: 'colony-sidebar-section' }, 'Meetings'),
          createElement('ul', { className: 'meeting-topic-list' }, ...topicItems),
        )
      : null,
    mobileSettings,
  );
}
