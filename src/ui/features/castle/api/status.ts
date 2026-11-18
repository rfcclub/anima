import { AgentLoader } from "../../../../agents/loader";
import { SessionManager } from "../../../../session/manager";
import { MeetingRoom } from "../../../../meeting/room";
import { getSessionStore } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { AgentStatus } from "../../../types";

export async function handleStatus(roomsDir: string): Promise<Response> {
  const loader = new AgentLoader({ roomsDir });
  const sessionStore = getSessionStore();

  const names = await loader.list();
  const agents: AgentStatus[] = [];

  for (const name of names) {
    const mgr = new SessionManager({ store: sessionStore });
    const session = mgr.openSession(name, "ui");
    const turns = mgr.getTurns(session.id);
    let model: string | undefined;
    let provider: string | undefined;
    try {
      const agent = await loader.load(name);
      model = agent.config.provider.model;
      provider = agent.config.provider.type;
    } catch { /* keep undefined */ }
    agents.push({
      name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      status: "online",
      turnCount: turns.length,
      model,
      provider,
    });
  }

  // Get meeting topics
  const meetingRoom = new MeetingRoom({ roomsDir });
  const meetingTopics = await meetingRoom.listTopics();

  return json({ agents, meetingTopics });
}
