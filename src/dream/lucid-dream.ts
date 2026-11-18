import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBeamEntries, type BeamEntry } from "./light-nap";
import { CrossingManager } from "../continuity/crossing";
import type {
  Provider,
  ProviderChunk,
  ProviderRequest,
  ProviderResponse,
} from "../providers/interface";
import type { AgentMemoryStore } from "../memory/contract";

export interface LucidDreamOptions {
  roomDir: string;
  /** Shared rooms root — used to look up DeepDream's staging/dreams/<date>.md
   *  reports, which live outside any single agent's roomDir. */
  roomsDir: string;
  agentName: string;
  provider: Provider;
  userPrompt?: string;
  model?: string;
  /** When provided, the reflection is persisted directly via
   *  AgentMemoryStore.remember() after the LLM call — not through an
   *  anima_remember tool call, since LucidDream runs outside a tool-enabled
   *  session loop and predates that tool. */
  memoryStore?: AgentMemoryStore;
}

export interface LucidDreamResult {
  response: string;
  storedAt: string;
}

/**
 * Lucid Dream — agent self-triggered internal processing.
 * Reads recent beams, crossing context, builds a reflection prompt,
 * sends it to the LLM provider, and stores the response as a markdown file.
 */
export class LucidDream {
  private static readonly MAX_LUCID_DREAM_FILES = 5;
  private crossingManager: CrossingManager;

  constructor() {
    this.crossingManager = new CrossingManager();
  }

  /**
   * Run a lucid dream session. Returns the reflection text and the path
   * to the stored dream file.
   */
  async run(options: LucidDreamOptions): Promise<LucidDreamResult> {
    const { roomDir, roomsDir, agentName, provider, userPrompt, model, memoryStore } = options;

    // 1. Prefer DeepDream's already-cross-referenced reports over re-deriving
    // from raw beams; only fall back to raw beams when no DeepDream report
    // exists anywhere in the last 3 days. (LucidDream would otherwise
    // ignore the cross-agent linking DeepDream already did.)
    const dreamReports = await this.readRecentDeepDreamReports(roomsDir, 3);
    const beams = dreamReports.length === 0 ? await this.readRecentBeams(roomDir, 3) : [];

    // 2. Read crossing context
    const crossing = await this.crossingManager.load(roomDir);
    const crossingInjection = crossing
      ? this.crossingManager.buildCrossingInjection(crossing)
      : "";

    // 3. Build reflection prompt
    const prompt = this.buildReflectionPrompt(
      agentName,
      userPrompt,
      beams,
      dreamReports,
      crossingInjection,
    );

    // 4. Send to LLM provider
    const providerRequest: ProviderRequest = {
      agent: agentName,
      messages: [{ role: "user", content: prompt }],
      mode: "plan",
      model,
    };

    const providerResult = await provider.query(providerRequest);
    const responseText = await this.extractResponseText(providerResult);

    // 5. Store in staging/dreams/
    const timestamp = this.buildTimestamp();
    const dreamsDir = join(roomDir, "staging", "dreams");
    await mkdir(dreamsDir, { recursive: true });
    const filePath = join(dreamsDir, `lucid-${timestamp}.md`);

    const content = [
      `# Lucid Dream — ${agentName}`,
      `- Timestamp: ${new Date().toISOString()}`,
      `- Prompt: ${userPrompt || "(none)"}`,
      "",
      "## Reflection",
      responseText,
      "",
    ].join("\n");

    await writeFile(filePath, content, "utf-8");
    await this.pruneOldLucidDreams(dreamsDir);

    // 6. Persist the reflection directly into the agent's memory, when a
    // store is available — bypasses the LLM tool-call loop entirely since
    // LucidDream runs outside any tool-enabled session.
    if (memoryStore) {
      await memoryStore.remember({
        content: responseText,
        scope: "observation",
        confidence: 0.8,
        tags: ["lucid-dream"],
        source: "lucid-dream",
      });
    }

    return {
      response: responseText,
      storedAt: filePath,
    };
  }

  /**
   * Keep only the MAX_LUCID_DREAM_FILES most recent lucid-*.md files in
   * dreamsDir, deleting the oldest ones — the file has no reader (nothing
   * in ANIMA reads it back; memoryStore.remember() above is
   * the actually-consulted copy now), so it's a bounded audit trail, not
   * an unbounded log. (requirement: keep the 5 most recent lucid versions)
   */
  private async pruneOldLucidDreams(dreamsDir: string): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dreamsDir);
    } catch {
      return;
    }
    const lucidFiles = files.filter((f) => f.startsWith("lucid-") && f.endsWith(".md")).sort();
    const excess = lucidFiles.length - LucidDream.MAX_LUCID_DREAM_FILES;
    if (excess <= 0) return;
    for (const file of lucidFiles.slice(0, excess)) {
      try {
        await unlink(join(dreamsDir, file));
      } catch {
        // best-effort — a file already removed by a concurrent run is fine
      }
    }
  }

  /**
   * Read DeepDream's consolidated reports (staging/dreams/<date>.md, shared
   * across all agents under roomsDir) for the most recent `maxDates` dates
   * that actually have a report file. Whole-file text, unfiltered — the
   * value of reading this over raw beams is precisely the cross-agent
   * linking DeepDream already computed.
   */
  private async readRecentDeepDreamReports(roomsDir: string, maxDates: number): Promise<string[]> {
    const dreamsDir = join(roomsDir, "staging", "dreams");
    if (!existsSync(dreamsDir)) return [];

    let files: string[];
    try {
      files = await readdir(dreamsDir);
    } catch {
      return [];
    }

    const recentFiles = files
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, maxDates);

    const reports: string[] = [];
    for (const file of recentFiles) {
      try {
        reports.push(await readFile(join(dreamsDir, file), "utf-8"));
      } catch {
        // skip unreadable files
      }
    }
    return reports;
  }

  /**
   * Read recent beam files from the agent's staging/beams/ directory.
   */
  private async readRecentBeams(
    roomDir: string,
    maxDates: number,
  ): Promise<BeamEntry[]> {
    const beamsDir = join(roomDir, "staging", "beams");
    if (!existsSync(beamsDir)) return [];

    let files: string[];
    try {
      files = await readdir(beamsDir);
    } catch {
      return [];
    }

    // Most recent markdown files first, take top N
    const recentFiles = files
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, maxDates);

    const allBeams: BeamEntry[] = [];
    for (const file of recentFiles) {
      try {
        const content = await readFile(join(beamsDir, file), "utf-8");
        const entries = parseBeamEntries(content);
        allBeams.push(...entries);
      } catch {
        // skip unreadable files
      }
    }

    return allBeams;
  }

  /**
   * Build a reflection prompt incorporating user input, DeepDream reports
   * (or raw beams when no report exists yet), and crossing context.
   */
  private buildReflectionPrompt(
    agentName: string,
    userPrompt: string | undefined,
    beams: BeamEntry[],
    dreamReports: string[],
    crossingInjection: string,
  ): string {
    const sections: string[] = [];

    sections.push(
      `[System] You are ${agentName} in a lucid dream state. Reflect on the following context.`,
    );

    if (userPrompt) {
      sections.push(`[User Prompt]\n${userPrompt}`);
    }

    if (dreamReports.length > 0) {
      sections.push(
        "[Recent Deep Dream Reports — already cross-referenced across the colony]\n" +
          dreamReports.join("\n\n---\n\n"),
      );
    } else if (beams.length > 0) {
      const beamLines = beams.map(
        (b) =>
          `- [${b.timestamp}] (${b.keywords.join(", ")}) ${b.content}`,
      );
      sections.push("[Recent Beams]\n" + beamLines.join("\n"));
    }

    if (crossingInjection) {
      sections.push(crossingInjection);
    }

    sections.push(
      "[Instructions]\nReflect on the above context. What patterns emerge? What should you carry forward? What remains unresolved? Provide your reflection in a thoughtful, introspective manner.",
    );

    return sections.join("\n\n");
  }

  /**
   * Build a timestamp string for the lucid dream filename: YYYY-MM-DDTHHmm.
   */
  private buildTimestamp(): string {
    const now = new Date();
    const yymmdd = now.toISOString().slice(0, 10);
    const hhmm =
      String(now.getUTCHours()).padStart(2, "0") +
      String(now.getUTCMinutes()).padStart(2, "0");
    return `${yymmdd}T${hhmm}`;
  }

  /**
   * Extract the response text from a provider result.
   * Assumes non-streaming (Promise<ProviderResponse>).
   */
  private async extractResponseText(
    result: ProviderResponse | AsyncGenerator<ProviderChunk>,
  ): Promise<string> {
    if (Symbol.asyncIterator in (result as AsyncGenerator<ProviderChunk>)) {
      const chunks: string[] = [];
      for await (const chunk of result as AsyncGenerator<ProviderChunk>) {
        if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
        if (chunk.type === "error") throw new Error(chunk.error ?? "provider stream error");
      }
      return chunks.join("");
    }

    const response = result as ProviderResponse;
    return typeof response.message.content === "string"
      ? response.message.content
      : JSON.stringify(response.message.content);
  }
}
