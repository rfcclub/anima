/** @deprecated Gemini is now registered via providers.d/gemini.yaml and uses OpenAIv1ChatProvider automatically. */
import { OpenAIv1ChatProvider } from "./openai-v1-chat";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.0-flash";

/** @deprecated Use ProviderRegistry + OpenAIv1ChatProvider via providers.d/gemini.yaml */
export class GeminiProvider extends OpenAIv1ChatProvider {
  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY not set");
    super({
      id: "gemini",
      label: "Google Gemini",
      api: "openai-completions",
      baseUrl: GEMINI_BASE_URL,
      apiKey: key,
      models: [{ id: DEFAULT_MODEL }],
    });
  }
}
