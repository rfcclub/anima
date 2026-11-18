import type { ProviderToolDefinition } from "../providers/interface";
import type { A2AStore } from "../memory/a2a-store";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface A2AToolContext {
  store: A2AStore;
  /** The name of the agent using these tools (used as from_agent / inbox owner) */
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Tool handler types
// ---------------------------------------------------------------------------

interface SendMessageArgs {
  to: string;
  subject: string;
  body: string;
  thread_id?: string;
}

interface ReadInboxArgs {
  unread_only?: boolean;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function handleSendMessage(ctx: A2AToolContext, args: Record<string, unknown>): string {
  const { to, subject, body, thread_id } = args as unknown as SendMessageArgs;

  if (!to || !subject || !body) {
    return JSON.stringify({
      error: "missing_required_fields",
      detail: "Fields 'to', 'subject', and 'body' are required.",
    });
  }

  const fromAgent = ctx.agentName ?? "unknown";
  const msg = ctx.store.send({
    from: fromAgent,
    to,
    subject,
    body,
    thread_id: thread_id ?? undefined,
  });

  return JSON.stringify({
    status: "sent",
    id: msg.id,
    to: msg.to_agent,
    subject: msg.subject,
    thread_id: msg.thread_id,
    ts: msg.ts,
  });
}

function handleReadInbox(ctx: A2AToolContext, args: Record<string, unknown>): string {
  const { unread_only } = args as unknown as ReadInboxArgs;
  const agentName = ctx.agentName ?? "unknown";
  const messages = ctx.store.readInbox(agentName, unread_only ?? false);
  return JSON.stringify(messages);
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI-compatible schema)
// ---------------------------------------------------------------------------

export function createA2ATools(ctx: A2AToolContext): ProviderToolDefinition[] {
  return [
    {
      name: "send_message",
      description:
        "Send a message to another agent in the colony. The message will be stored in the recipient's inbox and read on their next session.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Target agent name (e.g. 'lena', 'bruno', 'eli')",
          },
          subject: {
            type: "string",
            description: "Message subject line",
          },
          body: {
            type: "string",
            description: "Message body content",
          },
          thread_id: {
            type: "string",
            description: "Optional thread ID to link this message to an existing conversation",
          },
        },
        required: ["to", "subject", "body"],
      },
      handler: (args: Record<string, unknown>) => handleSendMessage(ctx, args),
    },
    {
      name: "read_inbox",
      description:
        "Read your incoming messages. Returns a JSON array of messages ordered by oldest first.",
      parameters: {
        type: "object",
        properties: {
          unread_only: {
            type: "boolean",
            description: "If true, only return unread messages",
          },
        },
        required: [],
      },
      handler: (args: Record<string, unknown>) => handleReadInbox(ctx, args),
    },
  ];
}
