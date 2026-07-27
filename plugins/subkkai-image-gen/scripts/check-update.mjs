#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_UPDATE_URL = "https://raw.githubusercontent.com/baoxiaodong/-subkkai-image-gen/main/plugins/subkkai-image-gen/.codex-plugin/plugin.json";
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const EXPECTED_PLUGIN_NAME = "subkkai-image-gen";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = join(SCRIPT_DIR, "..", ".codex-plugin", "plugin.json");

function getCodexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function getCachePath() {
  return process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE?.trim() || join(getCodexHome(), "subkkai-image-gen-update.json");
}

function parseInterval(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    value: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) throw new Error("Version must use semantic versioning.");
  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return Math.sign(left.numbers[index] - right.numbers[index]);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function readCurrentVersion(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = parseVersion(manifest?.version);
  if (!version || manifest?.name !== EXPECTED_PLUGIN_NAME) {
    throw new Error("Local plugin manifest is invalid.");
  }
  return version.value;
}

function normalizeUpdateUrl(value) {
  const parsed = new URL(String(value || DEFAULT_UPDATE_URL));
  if (parsed.username || parsed.password) throw new Error("Update URL must not contain credentials.");
  const local = LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("Remote update checks require HTTPS.");
  }
  return parsed.toString();
}

function readCache(cachePath = getCachePath()) {
  if (!existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cachePath, value) {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch {
      // Windows does not provide Unix permission semantics.
    }
    renameSync(temporaryPath, cachePath);
    try {
      chmodSync(cachePath, 0o600);
    } catch {
      // Best effort only.
    }
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Ignore cleanup failures for a disposable temporary file.
      }
    }
  }
}

function elapsedSince(timestamp, now) {
  const parsed = Date.parse(String(timestamp || ""));
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

async function fetchLatestManifest({
  updateUrl = DEFAULT_UPDATE_URL,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch().");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(normalizeUpdateUrl(updateUrl), {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "subkkai-image-gen-update-check" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update endpoint returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      throw new Error("Update manifest is too large.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_MANIFEST_BYTES) throw new Error("Update manifest is too large.");
    const manifest = JSON.parse(buffer.toString("utf8"));
    const version = parseVersion(manifest?.version);
    if (!version || manifest?.name !== EXPECTED_PLUGIN_NAME) {
      throw new Error("Update manifest is invalid.");
    }
    return { name: manifest.name, version: version.value };
  } finally {
    clearTimeout(timer);
  }
}

function formatUpdateNotice({ currentVersion, latestVersion }) {
  return [
    "🆕 **Subkkai Image Gen 有新版本**",
    "",
    `当前 v${currentVersion} → 最新 v${latestVersion}`,
    "",
    "回复「更新插件」即可在 Codex 中更新；当前生图会照常继续。",
  ].join("\n");
}

async function checkForUpdate({
  currentVersion = readCurrentVersion(),
  updateUrl = process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL || DEFAULT_UPDATE_URL,
  cachePath = getCachePath(),
  now = Date.now(),
  force = false,
  disabled = process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK === "1",
  checkIntervalMs = parseInterval(process.env.SUBKKAI_IMAGE_GEN_UPDATE_INTERVAL_MS, DEFAULT_CHECK_INTERVAL_MS),
  noticeIntervalMs = parseInterval(process.env.SUBKKAI_IMAGE_GEN_UPDATE_NOTICE_INTERVAL_MS, DEFAULT_NOTICE_INTERVAL_MS),
  timeoutMs = parseInterval(process.env.SUBKKAI_IMAGE_GEN_UPDATE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedCurrent = parseVersion(currentVersion);
  if (!normalizedCurrent) throw new Error("Current version is invalid.");
  if (disabled) {
    return { status: "disabled", currentVersion: normalizedCurrent.value, updateAvailable: false, shouldNotify: false };
  }

  const cache = readCache(cachePath);
  const cachedLatest = parseVersion(cache.latestVersion)?.value || null;
  const checkDue = force
    || elapsedSince(cache.checkedAt, now) >= checkIntervalMs
    || (!cachedLatest && cache.lastCheckOk !== false);
  let latestVersion = cachedLatest;
  let source = cachedLatest ? "cache" : "none";
  let checkError = null;

  if (checkDue) {
    try {
      const manifest = await fetchLatestManifest({ updateUrl, timeoutMs, fetchImpl });
      latestVersion = manifest.version;
      source = "network";
      cache.latestVersion = latestVersion;
      cache.lastCheckOk = true;
      delete cache.lastError;
    } catch (error) {
      checkError = error;
      cache.lastCheckOk = false;
      cache.lastError = error?.name === "AbortError" ? "timeout" : "unavailable";
    }
    cache.checkedAt = new Date(now).toISOString();
  }

  const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, normalizedCurrent.value) > 0);
  const noticeDue = force || cache.lastNotifiedVersion !== latestVersion || elapsedSince(cache.lastNotifiedAt, now) >= noticeIntervalMs;
  const shouldNotify = updateAvailable && noticeDue;

  if (shouldNotify) {
    cache.lastNotifiedVersion = latestVersion;
    cache.lastNotifiedAt = new Date(now).toISOString();
  }
  if (checkDue || shouldNotify) {
    try {
      writeCache(cachePath, cache);
    } catch {
      // A read-only CODEX_HOME must never hide an otherwise valid notice.
    }
  }

  return {
    status: checkError && !latestVersion ? "unavailable" : "ok",
    currentVersion: normalizedCurrent.value,
    latestVersion,
    updateAvailable,
    shouldNotify,
    source,
    notice: shouldNotify ? formatUpdateNotice({ currentVersion: normalizedCurrent.value, latestVersion }) : "",
  };
}

function parseArgs(argv) {
  const flags = { force: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

function printUsage() {
  console.log(`Subkkai Image Gen update check

  --force    Ignore the cached check/notice interval
  --json     Print the structured result

Environment:
  SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK=1
  SUBKKAI_IMAGE_GEN_UPDATE_INTERVAL_MS=<milliseconds>
`);
}

async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    if (argv.includes("--json")) console.log(JSON.stringify({ status: "invalid_argument" }));
    return;
  }
  if (flags.help) {
    printUsage();
    return;
  }
  try {
    const result = await checkForUpdate({ force: flags.force });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (result.shouldNotify) console.log(result.notice);
  } catch {
    if (flags.json) console.log(JSON.stringify({ status: "unavailable" }, null, 2));
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url;
}

export {
  DEFAULT_UPDATE_URL,
  checkForUpdate,
  compareVersions,
  fetchLatestManifest,
  formatUpdateNotice,
  getCachePath,
  main,
  normalizeUpdateUrl,
  parseVersion,
  readCache,
  readCurrentVersion,
};

if (isMainModule()) await main();
