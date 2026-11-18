# VISUAL_NOVEL_STAGE

Interactive visual novel interface for agent conversations. Each agent is a character on stage with portrait, mood, dialogue, and branching choices.

## Route

```
GET  /stage/:agentId  ->  stage.html
POST /api/talk/:agentId  ->  SSE stream
GET  /api/history/:agentId?n=20  ->  recent turns
```

The server reads `agentId` from the URL path. The stage HTML is a static Bun HTML import served at `/stage/:agentId`.

## Component Tree

```
Stage
├── SceneBackground — radial gradient, mood lighting (warm/cool/dark/bright)
│   ├── CharacterPortrait — 160px circle, agent color, emotion via CSS transition
│   └── AgentTitle — agent display name
├── DialogueArea
│   ├── ConversationLog — scrollable history of user + assistant turns
│   └── DialogueBox
│       ├── DialogueSpeaker — agent name in accent color
│       ├── DialogueText — typewriter output, italic/bold/code support
│       ├── ChoicePanel — interactive buttons with keyboard shortcuts
│       └── InputArea — text input + send button
```

## SSE Streaming

When the user sends a message via `POST /api/talk/:agentId`:

```
Client: POST /api/talk/:agentId { message, mode }
Server: SSE stream of text chunks:
  data: {"chunk here"}\n\n
  data: [DONE]\n\n
```

The client consumes the stream with `ReadableStream.getReader()` feeding into the typewriter engine.

## Typewriter Engine

```
TypewriterState:
  buffer: string       // accumulated text not yet displayed
  timer: number        // setInterval handle
  active: boolean      // is currently typing
  target: HTMLElement  // dialogue-text element

startTypewriter(element):
  buffer = ""
  active = true
  element.classList.add("typing")
  timer = setInterval(25ms) → pop first char from buffer into element.textContent

appendToTypewriter(text): buffer += text

flushTypewriter(): clear timer, dump remaining buffer, remove "typing" class
```

- **Interval**: 25ms per character
- **[DONE] signal**: calls `flushTypewriter()` to show full response
- **Italic/bold/code**: rendered via innerHTML with `*italic*`, `**bold**`, `` `code` `` transformation (future enhancement)
- Typing cursor blinks via CSS `:after { content: "▊"; animation: blink }`

## Emotion System

The agent returns structured JSON responses with mood and emotion:

```json
{ "text": "...", "mood": "warm", "emotion": "slight_smile" }
```

- **Mood** maps to scene background gradient: warm (amber/gold), cool (blue/silver), dark (charcoal), bright (cream/gold), neutral (default)
- **Emotion** maps to portrait CSS transitions -- currently color/box-shadow changes; future layer-based expression overlays
- Default mood per agent from `AgentTheme.defaultMood`

## Per-Agent Theming

```typescript
interface AgentTheme {
  colors: { primary, secondary, accent, background, text };
  fontStyle: string;            // "monospace" for 2B, system for Bruno
  defaultMood: AgentMood;       // "warm" for Bruno, "cool" for 2B
  portraitPosition: "left" | "center" | "right";
}
```

Themes are defined in `AGENT_COLORS` and `AGENT_LABELS` maps on stage.html. CSS custom properties (`--portrait-color`, `--accent-color`) are set at init from the theme.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Submit message (when input focused) |
| 1-4 | Select the Nth choice button |
| Ctrl+Enter | (reserved for multiline) |

Choices are rendered as `<button>` elements with a visible shortcut badge (`[1]`, `[2]`, etc.). The `keydown` listener intercepts numeric keys only when `choices.length > 0`.
