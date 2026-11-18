/** Host-controlled VM boundary for an external work session. */
export interface VmStartInput {
  sessionId: string;
  root: string;
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
  task: string;
  timeoutMs: number;
}

export interface VmHandle {
  exited: Promise<{ code: number | null }>;
  kill(): Promise<void>;
  gone(): Promise<boolean>;
  /** Cleanup failure after cessation; callers must not treat it as successful completion. */
  cleanupError?(): string | undefined;
  output(): Promise<string>;
}

export interface VmRunner {
  start(input: VmStartInput): Promise<VmHandle>;
}
