import { MeetingRoom } from "../../../../meeting/room";
import { defaultRoomsDir } from "../../../services/session-store";
import { json } from "../../../utils/http";
import type { UIServerDeps } from "../../../types";


export async function handleMeet(
  req: Request,
  deps?: UIServerDeps,
): Promise<Response> {
  let body: { agents?: string[]; topic?: string; turns?: number; inject?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  if (!body.agents || !body.topic) {
    return json({ error: "agents_and_topic_required" }, 400);
  }

  const roomsDir = deps?.roomsDir ?? defaultRoomsDir();

  // Use injected provider if available (for testing)
  const meetingRoom = new MeetingRoom({
    roomsDir,
    provider: deps?.providers?.get(body.agents[0]),
  });

  // Run the meeting and stream the result as SSE
  const transcript = await meetingRoom.run(body.agents, body.topic, {
    turns: body.turns,
    inject: body.inject,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(transcript)}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

