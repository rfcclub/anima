import { startWebChatHost } from "../../../src/web-chat/host";
const host = await startWebChatHost(process.argv[2]!);
console.log(host.pid);
process.exit(0);
