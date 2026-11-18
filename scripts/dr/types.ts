export type Status = "pass" | "fail" | "unknown";

export interface CheckResult {
  id: string;
  subject?: string;
  status: Status;
  reason?: string;
  detail?: Record<string, string | number>;
}

export interface Incident {
  openedAt: number;
  reason: string;
  alertSent: boolean;
  capAlertSent: boolean;
}

export interface State {
  version: 1;
  failCount: Record<string, number>;
  incidents: Record<string, Incident>;
  restarts: Record<string, number[]>;
  runSamples: Record<string, { t: number; runs: number }[]>;
  presenceSince: Record<string, number>;
  lastGoodHash?: string;
  queue: { kind: "open" | "recovered" | "cap" | "last-good-invalid"; key: string; text: string }[];
}

export interface Clock {
  now(): number;
}

export interface Fs {
  read(path: string): string | undefined;
  write(path: string, data: string): void;
  rename(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  stat(path: string): { size: number } | undefined;
  mkdir(path: string): void;
  readdir(path: string): string[];
  size(path: string): number;
}
