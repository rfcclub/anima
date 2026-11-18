import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GardenEvent, GardenEventType } from "./events";
import { createGardenEvent, validateGardenEvent } from "./events";

export interface GardenEventFilter {
  project?: string;
  type?: GardenEventType;
}

export class JsonlGardenEventStore {
  constructor(private readonly path: string) {}

  async append(event: GardenEvent): Promise<void> {
    validateGardenEvent(event);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf-8");
  }

  /** Projection drains may replay after a crash. Event ids are deterministic,
   * so a retry is a no-op rather than a duplicate visible speech frame. */
  async appendIfAbsent(event: GardenEvent): Promise<boolean> {
    const existing = await this.readAll({});
    if (existing.some((candidate) => candidate.id === event.id)) return false;
    await this.append(event);
    return true;
  }

  async readAll(filter: GardenEventFilter = {}): Promise<GardenEvent[]> {
    const events = await this.readRaw();
    return events.filter((event) => {
      if (filter.project && event.project !== filter.project) return false;
      if (filter.type && event.type !== filter.type) return false;
      return true;
    });
  }

  async readProject(project: string): Promise<GardenEvent[]> {
    return this.readAll({ project });
  }

  async readByType(type: GardenEventType): Promise<GardenEvent[]> {
    return this.readAll({ type });
  }

  private async readRaw(): Promise<GardenEvent[]> {
    let content = "";
    try {
      content = await readFile(this.path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => createGardenEvent(JSON.parse(line) as GardenEvent));
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
