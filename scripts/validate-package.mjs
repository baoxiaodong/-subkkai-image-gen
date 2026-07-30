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
assert.match(agentText, /short_description:\s*["']小站稳定 AI 生图与改图["']/);

const skillText = readFileSync(skillPath, "utf8");
assert.match(skillText, /Resolve `\.\.\/\.\.\/scripts\/generate\.mjs`/);
assert.doesNotMatch(skillText, /SCRIPT=\"\$HOME\/plugins\/subkkai-image-gen/);
assert.match(skillText, /Use the Subkkai optimized task APIs/);
assert.match(skillText, /POST \/v1\/image-tasks\/generations/);
assert.match(skillText, /POST \/v1\/image-tasks\/edits/);
assert.match(skillText, /model, prompt, n, size, image\[\]/);
assert.match(skillText, /short fixed delay between status requests/);
assert.match(skillText, /Do not resubmit automatically after task timeout/);
assert.match(skillText, /\/v1\/images\/generations/);
assert.match(skillText, /\/v1\/images\/edits/);
assert.match(skillText, /第一步：请提供你的 API Key/);
assert.match(skillText, /第二步：设置快速模式/);
assert.match(skillText, /选择默认 \*\*比例\*\*/);
assert.match(skillText, /每次默认生成 \*\*几张\*\*/);
assert.match(skillText, /--set-quick-mode --quality <Q> --ratio <R> --count <N>/);

console.log("Package validation passed.");
