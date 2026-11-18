#!/usr/bin/env bun
// Source workspaces are bundled by deploy.sh, rather than copied to ANIMA_HOME.
// Keep runtime external dependencies installable without a source checkout.
import { dirname, resolve } from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  throw new Error("usage: prepare-runtime-manifest.ts <source package.json> <destination package.json>");
}
const manifest = await Bun.file(source).json();
delete manifest.workspaces;
// Checkout skill generation has no source script in the deployed bundle directory.
for (const name of Object.keys(manifest.scripts ?? {})) {
  if (name === "postinstall" || name.startsWith("skills:")) delete manifest.scripts[name];
}
for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [name, value] of Object.entries(manifest[section] ?? {})) {
    if (typeof value !== "string") continue;
    if (value.startsWith("workspace:")) delete manifest[section][name];
    // Preserve local-development overrides without depending on ANIMA_HOME's sibling.
    else if (value.startsWith("link:")) manifest[section][name] = `file:${resolve(dirname(source), value.slice(5))}`;
  }
}
await Bun.write(destination, JSON.stringify(manifest, null, 2) + "\n");
