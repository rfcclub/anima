// ---------------------------------------------------------------------------
// AnimaAgentResponse — structured agent output type
// ---------------------------------------------------------------------------
// An agent may return plain text (wrapped as { text: "..." }) or a JSON
// object with optional mood, emotion, choices, and action fields. The UI
// (visual novel stage) reads these fields to render portraits, moods,
// choices, and scene transitions.
// ---------------------------------------------------------------------------

export type AgentMood = "warm" | "cool" | "dark" | "bright" | "neutral";

export interface AgentChoice {
  label: string;
  value: string;
}

export interface AnimaAgentResponse {
  /** Required: the dialogue text (displayed in the dialogue box) */
  text: string;
  /** Optional: scene mood (warm, cool, dark, bright, neutral) */
  mood: AgentMood | null;
  /** Optional: portrait emotion state (maps to portrait/{agentId}/{emotion}.png) */
  emotion: string | null;
  /** Optional: interactive choices for the user */
  choices: AgentChoice[] | null;
  /** Optional: action directive (e.g. "present_choice", "transition_scene") */
  action: string | null;
}
