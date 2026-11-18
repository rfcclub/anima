import type { ProviderDef } from "../config/types";
import { OpenAIv1ChatProvider } from "./openai-v1-chat";

/**
 * OpenAI Responses API provider (/v1/responses endpoint).
 * Currently delegates to the chat completions provider — full Responses API support is a future milestone.
 */
export class OpenAIv1ResponseProvider extends OpenAIv1ChatProvider {
  constructor(config: ProviderDef) {
    super({ ...config, endpoint: config.endpoint ?? "/responses" });
  }
}
