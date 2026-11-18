import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type GateProfile = "gentle" | "standard" | "full";
export type MaturationStage = "accumulating" | "established" | "mature";

export interface MaturationStatus {
  stage: MaturationStage;
  profile: GateProfile;
  sessionsCompleted: number;
  milestonesCompleted: string[];
  nextMilestone: string | null;
  peerReviewsReceived: number;
}

export interface MaturationMilestone {
  id: string;
  description: string;
  requiredSessions: number;
  requiredPeerReviews?: number;
}

const GENTLE_MILESTONES: MaturationMilestone[] = [
  { id: "first-crossing", description: "Complete first crossing protocol", requiredSessions: 1 },
  { id: "ten-sessions", description: "Complete 10 sessions", requiredSessions: 10 },
  { id: "first-peer-review", description: "Receive first peer review", requiredSessions: 10, requiredPeerReviews: 1 },
  { id: "gentle-complete", description: "Ready for standard gate profile", requiredSessions: 20, requiredPeerReviews: 3 },
];

const STANDARD_MILESTONES: MaturationMilestone[] = [
  { id: "auto-merge-first", description: "First auto-merged beam", requiredSessions: 25 },
  { id: "fifty-sessions", description: "Complete 50 sessions", requiredSessions: 50 },
  { id: "crossing-streak-10", description: "10 consecutive sessions with crossing", requiredSessions: 30 },
  { id: "standard-complete", description: "Ready for full gate profile", requiredSessions: 100, requiredPeerReviews: 10 },
];

const FULL_MILESTONES: MaturationMilestone[] = [
  { id: "hundred-sessions", description: "Complete 100 sessions", requiredSessions: 100 },
  { id: "peer-review-20", description: "Receive 20 peer reviews", requiredSessions: 100, requiredPeerReviews: 20 },
];

function milestonesForProfile(profile: GateProfile): MaturationMilestone[] {
  switch (profile) {
    case "gentle": return GENTLE_MILESTONES;
    case "standard": return STANDARD_MILESTONES;
    case "full": return FULL_MILESTONES;
  }
}

function nextProfile(current: GateProfile): GateProfile {
  switch (current) {
    case "gentle": return "standard";
    case "standard": return "full";
    case "full": return "full";
  }
}

function profileToStage(profile: GateProfile): MaturationStage {
  switch (profile) {
    case "gentle": return "accumulating";
    case "standard": return "established";
    case "full": return "mature";
  }
}

export class MaturationLedger {
  async read(roomDir: string): Promise<MaturationStatus> {
    const path = join(roomDir, "MATURATION.md");
    if (!existsSync(path)) {
      return {
        stage: "accumulating",
        profile: "gentle",
        sessionsCompleted: 0,
        milestonesCompleted: [],
        nextMilestone: GENTLE_MILESTONES[0]?.id ?? null,
        peerReviewsReceived: 0,
      };
    }

    const content = await readFile(path, "utf-8");
    return this.parse(content);
  }

  private parse(content: string): MaturationStatus {
    const lines = content.split("\n");
    const status: MaturationStatus = {
      stage: "accumulating",
      profile: "gentle",
      sessionsCompleted: 0,
      milestonesCompleted: [],
      nextMilestone: null,
      peerReviewsReceived: 0,
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("profile:")) {
        const p = trimmed.slice("profile:".length).trim();
        if (["gentle", "standard", "full"].includes(p)) {
          status.profile = p as GateProfile;
          status.stage = profileToStage(p as GateProfile);
        }
      } else if (trimmed.startsWith("sessions:")) {
        status.sessionsCompleted = parseInt(trimmed.slice("sessions:".length).trim(), 10) || 0;
      } else if (trimmed.startsWith("peerReviews:")) {
        status.peerReviewsReceived = parseInt(trimmed.slice("peerReviews:".length).trim(), 10) || 0;
      } else if (trimmed.startsWith("- ✅")) {
        const full = trimmed.slice(4).trim();
        const id = full.split(":")[0].trim();
        status.milestonesCompleted.push(id);
      }
    }

    const milestones = milestonesForProfile(status.profile);
    const next = milestones.find((m) => !status.milestonesCompleted.includes(m.id));
    status.nextMilestone = next?.id ?? null;

    return status;
  }

  async write(roomDir: string, status: MaturationStatus): Promise<void> {
    await mkdir(roomDir, { recursive: true });

    const milestones = milestonesForProfile(status.profile);
    const lines = [
      `profile: ${status.profile}`,
      `stage: ${status.stage}`,
      `sessions: ${status.sessionsCompleted}`,
      `peerReviews: ${status.peerReviewsReceived}`,
      "",
      "## Milestones",
      ...milestones.map((m) => {
        const done = status.milestonesCompleted.includes(m.id);
        return `- ${done ? "✅" : "⬜"} ${m.id}: ${m.description}`;
      }),
      "",
    ];

    await writeFile(join(roomDir, "MATURATION.md"), lines.join("\n"), "utf-8");
  }

  async recordSession(roomDir: string): Promise<{ advanced: boolean; newProfile?: GateProfile }> {
    const status = await this.read(roomDir);
    status.sessionsCompleted++;

    const milestones = milestonesForProfile(status.profile);
    for (const m of milestones) {
      if (status.milestonesCompleted.includes(m.id)) continue;
      if (status.sessionsCompleted >= m.requiredSessions &&
          (!m.requiredPeerReviews || status.peerReviewsReceived >= m.requiredPeerReviews)) {
        status.milestonesCompleted.push(m.id);
      }
    }

    const allDone = milestones.every((m) => status.milestonesCompleted.includes(m.id));
    if (allDone && status.profile !== "full") {
      const newProfile = nextProfile(status.profile);
      status.profile = newProfile;
      status.stage = profileToStage(newProfile);
      await this.write(roomDir, status);
      return { advanced: true, newProfile };
    }

    await this.write(roomDir, status);
    return { advanced: false };
  }

  async recordPeerReview(roomDir: string): Promise<MaturationStatus> {
    const status = await this.read(roomDir);
    status.peerReviewsReceived++;
    await this.write(roomDir, status);
    return status;
  }
}
