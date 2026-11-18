import { contextBridge, ipcRenderer } from "electron";

export interface FetchResult {
  ok: boolean;
  status: number;
  json?: unknown;
  error?: string;
}

contextBridge.exposeInMainWorld("anima", {
  fetchJson: (url: string): Promise<FetchResult> =>
    ipcRenderer.invoke("anima:fetch", url),
});
