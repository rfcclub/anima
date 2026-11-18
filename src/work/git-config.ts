/**
 * Reject known Git configuration that names a program before host completion or checkout.
 * This is defense in depth; the sandbox and neutral command options remain necessary.
 * Input is Git's NUL-delimited `config --list` output, including command-line options.
 */
export function executableGitConfig(config: string): "filter" | "command" | null {
  let command = false;
  for (const entry of config.split("\0")) {
    const [rawKey, ...valueParts] = entry.split("\n");
    const key = (rawKey ?? "").toLowerCase();
    const value = valueParts.join("\n").trim().toLowerCase();
    if (/^filter\..+\.(clean|smudge|process)$/.test(key)) return "filter";
    // The host itself supplies these harmless overrides in the config listing.
    if (key === "core.fsmonitor" && (value === "false" || value === "0")) continue;
    if (key === "core.hookspath" && value === "/dev/null") continue;
    if (["core.fsmonitor", "core.hookspath", "core.sshcommand", "core.pager", "core.editor",
      "core.gitproxy", "sequence.editor", "diff.external", "credential.helper"].includes(key) ||
      /^pager\./.test(key) || /^diff\..+\.(command|textconv)$/.test(key) ||
      /^merge\..+\.driver$/.test(key) || /^gpg\..*program$/.test(key) ||
      /^remote\..+\.(uploadpack|receivepack)$/.test(key)) command = true;
  }
  return command ? "command" : null;
}
