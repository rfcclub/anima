import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ANIMA',
  description: 'Multi-agent runtime documentation',
  base: '/docs/',
  ignoreDeadLinks: false,
  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.png' }]
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/architecture' },
      { text: 'Agents', link: '/agents/overview' },
      { text: 'Cartridge', link: '/cartridge/overview' },
      { text: 'Substrate', link: '/substrate/overview' },
      { text: 'Sessions', link: '/sessions/lifecycle' },
      { text: 'Providers', link: '/providers/overview' },
      { text: 'Channels', link: '/channels/cli' },
      { text: 'Colony', link: '/colony/overview' },
      { text: 'Tools', link: '/tools/policy' },
      { text: 'CLI', link: '/cli/reference' },
      { text: 'API', link: '/api/execution-plan' },
      { text: 'ADR', link: '/adr/0001-cartridge-architecture' },
      {
        text: 'Misc',
        items: [
          { text: 'SOUL vs AGENTS vs SKILL', link: '/misc/soul-vs-agents-vs-skill' },
          { text: 'Castle System', link: '/misc/castle-system' },
          { text: 'Proxy System', link: '/misc/proxy-system' },
          { text: 'Prompt Caching', link: '/misc/prompt-caching' },
          { text: 'Garden System', link: '/misc/garden-system' },
          { text: 'Agent Substrate', link: '/misc/agent-substrate' },
          { text: 'Colony Mesh', link: '/misc/colony-mesh' },
        ]
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Security Status', link: '/guide/security' },
          ]
        }
      ],
      '/agents/': [
        {
          text: 'Agents',
          items: [
            { text: 'Overview', link: '/agents/overview' },
            { text: 'Rooms', link: '/agents/rooms' },
            { text: 'Identity', link: '/agents/identity' },
            { text: 'Config', link: '/agents/config' },
            { text: 'Roles', link: '/agents/roles' },
          ]
        }
      ],
      '/cartridge/': [
        {
          text: 'Cartridge System',
          items: [
            { text: 'Overview', link: '/cartridge/overview' },
            { text: 'Layers', link: '/cartridge/layers' },
            { text: 'Kinds', link: '/cartridge/kinds' },
            { text: 'Activation', link: '/cartridge/activation' },
            { text: 'Creating', link: '/cartridge/creating' },
            { text: 'Agent Skills', link: '/cartridge/skills' },
          ]
        }
      ],
      '/substrate/': [
        {
          text: 'Substrate & Memory',
          items: [
            { text: 'Overview', link: '/substrate/overview' },
            { text: 'Retrieval', link: '/substrate/retrieval' },
            { text: 'Identity Engine', link: '/substrate/identity-engine' },
            { text: 'Identity Engine Deep Dive', link: '/substrate/identity-engine-detail' },
            { text: 'Memory', link: '/substrate/memory' },
            { text: 'Mapping Guide', link: '/substrate/mapping-guide' },
          ]
        }
      ],
      '/sessions/': [
        {
          text: 'Sessions',
          items: [
            { text: 'Lifecycle', link: '/sessions/lifecycle' },
            { text: 'Modes', link: '/sessions/modes' },
            { text: 'Context Engine', link: '/sessions/context-engine' },
            { text: 'Thread Management', link: '/sessions/thread-management' },
            { text: 'Scheduling', link: '/sessions/scheduling' },
            { text: 'Dream System', link: '/sessions/dream' },
          ]
        }
      ],
      '/providers/': [
        {
          text: 'Providers',
          items: [
            { text: 'Overview', link: '/providers/overview' },
            { text: 'Router', link: '/providers/router' },
            { text: 'Models', link: '/providers/models' },
          ]
        }
      ],
      '/channels/': [
        {
          text: 'Channels',
          items: [
            { text: 'CLI', link: '/channels/cli' },
            { text: 'HTTP', link: '/channels/http' },
            { text: 'Telegram', link: '/channels/telegram' },
            { text: 'Web UI', link: '/channels/web-ui' },
            { text: 'Mesh', link: '/channels/mesh' },
          ]
        }
      ],
      '/colony/': [
        {
          text: 'Colony',
          items: [
            { text: 'Overview', link: '/colony/overview' },
            { text: 'Agora', link: '/colony/agora' },
            { text: 'Mesh Bus', link: '/colony/mesh-bus' },
            { text: 'Cross-Runtime', link: '/colony/cross-runtime' },
          ]
        }
      ],
      '/tools/': [
        {
          text: 'Tools',
          items: [
            { text: 'Policy', link: '/tools/policy' },
            { text: 'Permissions', link: '/tools/permissions' },
            { text: 'MCP', link: '/tools/mcp' },
            { text: 'Plugins', link: '/tools/plugins' },
          ]
        }
      ],
      '/cli/': [
        {
          text: 'CLI',
          items: [
            { text: 'Reference', link: '/cli/reference' },
          ]
        }
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'ExecutionPlan', link: '/api/execution-plan' },
            { text: 'CartridgeEntry', link: '/api/cartridge-entry' },
            { text: 'RetrievalPolicy', link: '/api/retrieval-policy' },
            { text: 'Memory Contract', link: '/api/memory-contract' },
          ]
        }
      ],
      '/adr/': [
        {
          text: 'Architecture Decisions',
          items: [
            { text: '0001: Cartridge Architecture', link: '/adr/0001-cartridge-architecture' },
            { text: '0002: Substrate View Layer', link: '/adr/0002-substrate-view-layer' },
          ]
        }
      ],
      '/misc/': [
        {
          text: 'Miscellaneous',
          items: [
            { text: 'SOUL vs AGENTS vs SKILL', link: '/misc/soul-vs-agents-vs-skill' },
            { text: 'Castle System', link: '/misc/castle-system' },
            { text: 'Proxy System', link: '/misc/proxy-system' },
            { text: 'Prompt Caching', link: '/misc/prompt-caching' },
            { text: 'Garden System', link: '/misc/garden-system' },
            { text: 'Agent Substrate', link: '/misc/agent-substrate' },
            { text: 'Colony Mesh', link: '/misc/colony-mesh' },
          ]
        }
      ],
    },
  },
})
