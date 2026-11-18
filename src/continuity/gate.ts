import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GateConfig } from "../config/types";
import type { JsonlEvent } from "../memory/jsonl-store";
import type { Provider, ProviderChunk, ProviderResponse } from "../providers/interface";
import {
  evaluateWoundEscalation,
  normalizeWoundType,
  woundSignature,
  type WoundType,
} from "./wound-taxonomy";

export type GateClassificationType = "weather" | "wound" | "beam";
export type { WoundType };

export interface GateClassification {
  eventIndex: number;
  type: GateClassificationType;
  confidence: number;
  reasoning: string;
  woundType?: WoundType;
}

export interface GatePipelineOptions {
  provider: Provider;
  agent: string;
  roomDir: string;
  gate: GateConfig;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

interface RawGateClassification {
  eventIndex?: unknown;
  type?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  woundType?: unknown;
  wound?: unknown;
}

const DEFAULT_THRESHOLD = 0.7;

export class GatePipeline {
  private readonly provider: Provider;
  private readonly agent: string;
  private readonly roomDir: string;
  private readonly gate: GateConfig;
  private readonly log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

  constructor(options: GatePipelineOptions) {
    this.provider = options.provider;
    this.agent = options.agent;
    this.roomDir = options.roomDir;
    this.gate = options.gate;
    this.log = options.log ?? structuredLog;
  }

  async classify(sessionEvents: JsonlEvent[]): Promise<GateClassification[]> {
    if (sessionEvents.length === 0) return [];

    try {
      return await this.classifyWithModel(sessionEvents, this.gate.model);
    } catch (primaryError) {
      if (this.gate.fallbackModel) {
        try {
          return await this.classifyWithModel(sessionEvents, this.gate.fallbackModel);
        } catch (fallbackError) {
          await this.queuePending(sessionEvents, [primaryError, fallbackError]);
          return [];
        }
      }

      await this.queuePending(sessionEvents, [primaryError]);
      return [];
    }
  }

  private async classifyWithModel(sessionEvents: JsonlEvent[], model?: string): Promise<GateClassification[]> {
    const response = await this.provider.query({
      agent: this.agent,
      mode: "plan",
      cwd: this.roomDir,
      model,
      system: gateSystemPrompt(this.gate.threshold ?? DEFAULT_THRESHOLD),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            events: sessionEvents.map((event, index) => ({ index, event })),
          }),
        },
      ],
    });

    const text = await providerText(response);
    const classifications = parseClassifications(text, sessionEvents.length);
    await this.stageClassifications(sessionEvents, classifications);
    return classifications;
  }

  private async stageClassifications(sessionEvents: JsonlEvent[], classifications: GateClassification[]): Promise<void> {
    for (const classification of classifications) {
      if (classification.confidence < (this.gate.threshold ?? DEFAULT_THRESHOLD)) continue;
      if (classification.type === "beam") {
        await this.stageBeam(sessionEvents[classification.eventIndex], classification);
      } else if (classification.type === "wound") {
        await this.handleWound(sessionEvents[classification.eventIndex], classification);
      }
    }
  }

  private async stageBeam(event: JsonlEvent, classification: GateClassification): Promise<void> {
    const filePath = join(this.roomDir, "staging", "beams", `${today()}.md`);
    await appendMarkdown(filePath, [
      "## Beam",
      `sessionId: ${event.sessionId}`,
      `eventIndex: ${classification.eventIndex}`,
      `confidence: ${classification.confidence}`,
      `reasoning: ${classification.reasoning}`,
      "",
      "```json",
      JSON.stringify(event, null, 2),
      "```",
      "",
    ].join("\n"));
  }

  private async handleWound(event: JsonlEvent, classification: GateClassification): Promise<void> {
    const woundType = classification.woundType ?? "pattern";
    const repeats = woundType === "pattern" ? await this.incrementPatternRepeat(classification) : 1;
    const escalation = evaluateWoundEscalation(woundType, repeats);

    this.log("warn", escalation.escalate ? `${woundType} wound escalated` : "pattern wound detected", {
      type: escalation.escalate ? "gate_wound_escalated" : "gate_pattern_wound",
      agent: this.agent,
      woundType,
      sessionId: event.sessionId,
      repeats,
      blockAutoMerge: escalation.blockAutoMerge,
    });

    if (escalation.escalate) {
      await this.escalateWound(event, classification, woundType, {
        repeats,
        blockAutoMerge: escalation.blockAutoMerge,
        escalationReason: escalation.reason,
      });
    }
  }

  private async escalateWound(
    event: JsonlEvent,
    classification: GateClassification,
    woundType: WoundType,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const filePath = join(this.roomDir, "staging", "wounds", `${today()}.md`);
    await appendMarkdown(filePath, [
      "## Wound",
      `sessionId: ${event.sessionId}`,
      `eventIndex: ${classification.eventIndex}`,
      `woundType: ${woundType}`,
      `confidence: ${classification.confidence}`,
      `reasoning: ${classification.reasoning}`,
      ...Object.entries(metadata).map(([key, value]) => `${key}: ${String(value)}`),
      "",
      "```json",
      JSON.stringify(event, null, 2),
      "```",
      "",
    ].join("\n"));
  }

  private async incrementPatternRepeat(classification: GateClassification): Promise<number> {
    const filePath = join(this.roomDir, "staging", "wounds", "pattern-repeats.json");
    const key = woundSignature(classification.reasoning);
    let counts: Record<string, number> = {};

    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf-8"));
        if (isRecord(parsed)) {
          counts = Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
          );
        }
      } catch {
        counts = {};
      }
    }

    counts[key] = (counts[key] ?? 0) + 1;
    await mkdir(join(this.roomDir, "staging", "wounds"), { recursive: true });
    await writeFile(filePath, JSON.stringify(counts, null, 2) + "\n", "utf-8");
    return counts[key];
  }

  private async queuePending(sessionEvents: JsonlEvent[], errors: unknown[]): Promise<void> {
    const filePath = join(this.roomDir, "staging", "wounds", "pending.jsonl");
    await mkdir(join(this.roomDir, "staging", "wounds"), { recursive: true });
    await appendLine(filePath, JSON.stringify({
      timestamp: new Date().toISOString(),
      agent: this.agent,
      models: [this.gate.model, this.gate.fallbackModel].filter(Boolean),
      errors: errors.map((error) => error instanceof Error ? error.message : String(error)),
      events: sessionEvents,
    }));
  }
}

function gateSystemPrompt(threshold: number): string {
  return [
    "Classify each ANIMA session event as weather, wound, or beam.",
    "weather: passing context, status, chatter, or non-structural event.",
    "beam: durable insight, decision, commitment, or pattern worth preserving.",
    "wound: structural risk or harm needing attention.",
    "Wounds may include woundType: pattern, relational, or substrate.",
    `Use confidence 0-1. Prefer weather below threshold ${threshold}.`,
    "Return only JSON: {\"classifications\":[{\"eventIndex\":0,\"type\":\"weather\",\"confidence\":0.8,\"reasoning\":\"...\",\"woundType\":\"pattern\"}]}",
  ].join("\n");
}

async function providerText(response: ProviderResponse | AsyncGenerator<ProviderChunk>): Promise<string> {
  if (isAsyncGenerator(response)) {
    const chunks: string[] = [];
    for await (const chunk of response) {
      if (chunk.type === "text" && chunk.content) chunks.push(chunk.content);
      if (chunk.type === "error") throw new Error(chunk.error ?? "provider stream error");
    }
    return chunks.join("");
  }

  const content = response.message.content;
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => "text" in part && typeof part.text === "string" ? part.text : "").join("");
}

function parseClassifications(text: string, eventCount: number): GateClassification[] {
  const parsed = JSON.parse(extractJson(text));
  const rawClassifications = Array.isArray(parsed) ? parsed : parsed.classifications;
  if (!Array.isArray(rawClassifications)) {
    throw new Error("gate response missing classifications array");
  }

  return rawClassifications.map((raw) => {
    if (!isRecord(raw)) {
      throw new Error("invalid gate classification");
    }
    return normalizeClassification(raw, eventCount);
  });
}

function normalizeClassification(raw: RawGateClassification, eventCount: number): GateClassification {
  const eventIndex = typeof raw.eventIndex === "number" ? raw.eventIndex : -1;
  const type = raw.type;
  const confidence = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence);
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  const woundType = raw.woundType ?? raw.wound;

  if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= eventCount) {
    throw new Error(`invalid gate eventIndex: ${eventIndex}`);
  }
  if (!["weather", "wound", "beam"].includes(String(type))) {
    throw new Error(`invalid gate type: ${String(type)}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`invalid gate confidence: ${String(raw.confidence)}`);
  }

  const classification: GateClassification = {
    eventIndex,
    type: type as GateClassificationType,
    confidence,
    reasoning,
  };

  classification.woundType = normalizeWoundType(woundType);

  return classification;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return trimmed;
  return trimmed.slice(start);
}

async function appendMarkdown(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? await readFile(filePath, "utf-8") : "";
  await writeFile(filePath, existing + content, "utf-8");
}

async function appendLine(filePath: string, line: string): Promise<void> {
  const existing = existsSync(filePath) ? await readFile(filePath, "utf-8") : "";
  await writeFile(filePath, existing + line + "\n", "utf-8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function structuredLog(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  console[level === "error" ? "error" : "log"](
    JSON.stringify({ level, ts: new Date().toISOString(), msg, ...fields }),
  );
}

function isAsyncGenerator(value: ProviderResponse | AsyncGenerator<ProviderChunk>): value is AsyncGenerator<ProviderChunk> {
  return typeof (value as AsyncGenerator<ProviderChunk>)[Symbol.asyncIterator] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
