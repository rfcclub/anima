// Test-only host policy; independent of production watcher behavior.
export function skipNativeWatchIntegration(host: { platform: string; bunVersion: string; optIn?: string }): boolean {
  return host.platform === "darwin" && ["1.3.14", "1.4.4"].includes(host.bunVersion) && host.optIn !== "1";
}
