#!/usr/bin/env node
/**
 * Bump the coder version in lockstep across every manifest that carries one:
 *   - package.json                              (npm)
 *   - plugins/claude/.claude-plugin/plugin.json (Claude Code plugin)
 *   - plugins/cursor/.cursor-plugin/plugin.json (Cursor plugin)
 *   - .cursor-plugin/marketplace.json           (Cursor marketplace, metadata.version)
 *
 * They must move together: the host plugins cache installs per version, so a
 * plugin whose version does not change keeps serving a stale copy even after
 * the files on disk change. Keeping them equal means one publish reliably
 * reaches CLI users and every host plugin.
 *
 * Usage: node scripts/bump.mjs <major|minor|patch>   (default: patch)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// Manifests with a top-level `version` field.
const MANIFESTS = [
  "package.json",
  "plugins/claude/.claude-plugin/plugin.json",
  "plugins/cursor/.cursor-plugin/plugin.json",
];

const level = (process.argv[2] ?? "patch").toLowerCase();
if (!["major", "minor", "patch"].includes(level)) {
  console.error(`Unknown bump level "${level}". Use one of: major, minor, patch.`);
  process.exit(1);
}

function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    console.error(`Cannot bump non-semver version "${version}".`);
    process.exit(1);
  }
  let [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (bump === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

// Take the current version from package.json as the source of truth, so the
// three files stay aligned even if one drifted.
const pkgPath = path.join(root, "package.json");
const current = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
const next = nextVersion(current, level);

for (const relative of MANIFESTS) {
  const file = path.join(root, relative);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = next;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ${relative}  ${current} -> ${next}`);
}

// The Cursor marketplace manifest carries its version under metadata, not at the
// top level, so it needs a separate touch to stay in lockstep.
const marketplaceRel = ".cursor-plugin/marketplace.json";
const marketplaceFile = path.join(root, marketplaceRel);
const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
marketplace.metadata = { ...marketplace.metadata, version: next };
fs.writeFileSync(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);
console.log(`  ${marketplaceRel}  ${current} -> ${next}`);

console.log(`\nBumped coder ${current} -> ${next} (${level}). Rebuild + republish to ship it.`);
