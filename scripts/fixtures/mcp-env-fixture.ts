// Real subprocess probe; return only presence flags for parent capabilities.
// This fixture performs no filesystem, network, Mesh or Telegram operation.
export {};

let buffer = "";
const reader = Bun.stdin.stream().getReader();
while (true) {
  const chunk = await reader.read();
  if (chunk.done) break;
  buffer += new TextDecoder().decode(chunk.value);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        parentSecretPresent: Boolean(process.env.ANIMA_FIXTURE_PARENT_SECRET),
        nativeCarrierPresent: Boolean(process.env.MESH_A2A_CAPABILITY || process.env.MESH_A2A_ADDRESS || process.env.MESH_INBOX_CHANNEL),
        telegramPresent: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_MCP_CHANNEL),
        home: process.env.HOME,
        sender: process.env.MESH_INSTANCE_ID,
      },
    }));
  }
}
