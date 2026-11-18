/**
 * Frontend bridge to the Rust SSH tunnel commands/events.
 * All functions no-op safely outside the Tauri shell.
 */

import type { SshProfile } from "./settings";
import type { ResolvedEndpoints } from "./endpoints";

export type SshStatus = "connected" | "reconnecting" | "disconnected";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const PASSPHRASE_REQUIRED = "PASSPHRASE_REQUIRED";

export async function connectSsh(
  profile: SshProfile,
  passphrase?: string,
): Promise<ResolvedEndpoints> {
  if (!inTauri()) throw new Error("SSH transport requires the desktop shell");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ResolvedEndpoints>("connect_ssh", {
    profile: {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      keyPath: profile.keyPath ?? null,
      agent: profile.agent ?? false,
      remotePorts: profile.remotePorts,
    },
    passphrase: passphrase ?? null,
  });
}

export async function disconnectSsh(): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("disconnect_ssh");
}

export async function getActiveEndpoints(): Promise<ResolvedEndpoints | null> {
  if (!inTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ResolvedEndpoints | null>("get_active_endpoints");
}

export async function onSshStatus(
  handler: (status: SshStatus) => void,
): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<SshStatus>("connection-status", (e) => handler(e.payload));
  return un;
}

export async function onEndpointsChanged(
  handler: (endpoints: ResolvedEndpoints) => void,
): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<ResolvedEndpoints>("endpoints-changed", (e) =>
    handler(e.payload),
  );
  return un;
}
