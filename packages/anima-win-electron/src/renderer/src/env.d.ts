export {};

declare global {
  interface Window {
    anima?: {
      fetchJson: (url: string) => Promise<{
        ok: boolean;
        status: number;
        json?: unknown;
        error?: string;
      }>;
    };
  }
}
