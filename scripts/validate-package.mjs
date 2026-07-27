#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "subkkai-image-gen");
const skillRoot = join(pluginRoot, "skills", "subkkai-image-gen");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertFile(path, label) {
  assert.ok(existsSync(path), `${label} missing: ${path}`);
  assert.ok(statSync(path).isFile(), `${label} is not a file: ${path}`);
}

const marketplace = readJson(join(repoRoot, ".agents", "plugins", "marketplace.json"));
const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = readJson(manifestPath);
const skillPath = join(skillRoot, "SKILL.md");
const agentPath = join(skillRoot, "agents", "openai.yaml");

assert.equal(marketplace.name, "subkkai");
assert.equal(marketplace.plugins?.[0]?.name, manifest.name);
assert.equal(marketplace.plugins?.[0]?.source?.path, "./plugins/subkkai-image-gen");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.interface?.websiteURL, "https://subkkai.com/");

assertFile(manifestPath, "plugin manifest");
assertFile(join(pluginRoot, "assets", "logo.png"), "plugin logo");
assertFile(join(pluginRoot, "scripts", "generate.mjs"), "generation script");
assertFile(join(pluginRoot, "scripts", "check-update.mjs"), "update check script");
assertFile(skillPath, "skill instructions");
assertFile(agentPath, "skill agent metadata");
assertFile(join(skillRoot, "assets", "logo.png"), "skill logo");

const agentText = readFileSync(agentPath, "utf8");
assert.match(agentText, /icon_small:\s*["']\.\/assets\/logo\.png["']/);
assert.match(agentText, /icon_large:\s*["']\.\/assets\/logo\.png["']/);

const skillText = readFileSync(skillPath, "utf8");
assert.match(skillText, /Resolve `\.\.\/\.\.\/scripts\/generate\.mjs`/);
assert.match(skillText, /`\.\.\/\.\.\/scripts\/check-update\.mjs`/);
assert.doesNotMatch(skillText, /SCRIPT=\"\$HOME\/plugins\/subkkai-image-gen/);
assert.match(skillText, /Start with `🎨 正在生成。` or `✏️ 正在编辑。`/);
assert.match(skillText, /immediately run exactly one image command/);
assert.match(skillText, /--edit --latest-image/);
assert.match(skillText, /Do not first run\s+`--get-config`/);
assert.match(skillText, /Do not require PTY\/TTY/);
assert.doesNotMatch(skillText, /with PTY\/TTY enabled/);
assert.match(skillText, /Do not inspect, critique, or describe the result/);
assert.match(skillText, /Copy that line verbatim into the final/);
assert.match(skillText, /Do not call another tool, copy\/move the file, Base64/);

console.log("Package validation passed.");
