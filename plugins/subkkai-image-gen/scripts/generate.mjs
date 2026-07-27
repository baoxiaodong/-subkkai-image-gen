#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { checkForUpdate } from "./check-update.mjs";

const DEFAULT_API_BASE = "https://subkkai.com";
const MODEL = "gpt-image-2";
const TASK_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_POLL_MS = 700;
const MAX_POLL_MS = 8_000;
const PROGRESS_HEARTBEAT_MS = 60_000;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_BATCH_FILE_BYTES = 1024 * 1024;
const MAX_ERROR_LENGTH = 1_200;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const SIZE_MATRIX = {
  "1K": { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" },
  "2K": { square: "2048x2048", landscape: "2048x1152", portrait: "1152x2048" },
  "4K": { square: "2880x2880", landscape: "3840x2160", portrait: "2160x3840" },
};

const DEFAULTS = { quality: "2K", ratio: "portrait", count: 1, concurrency: 3 };
const QUALITY_EMOJI = { "1K": "🚀", "2K": "✨", "4K": "💎" };
const RATIO_NAMES = { square: "正方形", landscape: "横版", portrait: "竖版" };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

function getCodexHome() {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function getConfigPath() {
  return process.env.SUBKKAI_IMAGE_GEN_CONFIG?.trim() || join(getCodexHome(), "subkkai-image-gen-config.json");
}

function getDefaultOutputDir() {
  return process.env.SUBKKAI_IMAGE_GEN_OUTPUT_DIR?.trim() || join(homedir(), "Pictures", "subkkai-image-gen");
}

function findLatestImage(outputDir = getDefaultOutputDir()) {
  const resolvedDir = resolvePath(outputDir);
  if (!existsSync(resolvedDir)) {
    throw new AppError("NO_IMAGE_AVAILABLE", "还没有可编辑的历史图片，请先生成、附加图片或提供图片路径。" );
  }

  const candidates = readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(resolvedDir, entry.name);
      const info = statSync(path);
      return { path, modifiedAt: info.mtimeMs, size: info.size };
    })
    .filter((entry) => entry.size > 0)
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));

  if (!candidates.length) {
    throw new AppError("NO_IMAGE_AVAILABLE", "还没有可编辑的历史图片，请先生成、附加图片或提供图片路径。" );
  }
  return candidates[0].path;
}

async function printUpdateNotice() {
  try {
    const result = await checkForUpdate();
    if (result.shouldNotify && result.notice) console.log(result.notice);
  } catch {
    // Update checks must never delay a user with an actionable error.
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function normalizeBaseUrl(value, { allowInsecure = false } = {}) {
  const raw = String(value ?? DEFAULT_API_BASE).trim();
  if (!raw) throw new AppError("INVALID_API_BASE", "API Base 不能为空。");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new AppError("INVALID_API_BASE", "API Base 必须是有效的 http(s) URL。", { cause: error });
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new AppError("INVALID_API_BASE", "API Base 只支持 http:// 或 https://。" );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError("INVALID_API_BASE", "API Base 不得包含用户名、密码、query 或 fragment。" );
  }
  if (parsed.protocol === "http:" && !isLocalHostname(parsed.hostname) && !allowInsecure && process.env.SUBKKAI_IMAGE_GEN_ALLOW_INSECURE !== "1") {
    throw new AppError("INSECURE_API_BASE", "远程 API Base 必须使用 HTTPS；仅允许 localhost 使用 HTTP。" );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeApiKey(value) {
  if (typeof value !== "string") throw new AppError("INVALID_API_KEY", "API Key 必须是字符串。" );
  const key = value.trim();
  if (!key) throw new AppError("INVALID_API_KEY", "API Key 不能为空。" );
  if (/\s/.test(key)) throw new AppError("INVALID_API_KEY", "API Key 不得包含空白字符。" );
  if (key.length > 4_096) throw new AppError("INVALID_API_KEY", "API Key 长度超过限制。" );
  return key;
}

function configuredApiKey(config) {
  const environmentKey = process.env.SUBKKAI_IMAGE_GEN_API_KEY?.trim();
  return environmentKey ? normalizeApiKey(environmentKey) : config.apiKey || null;
}

function sanitizeText(value, secrets = []) {
  let safe = String(value ?? "");
  for (const secret of secrets) {
    if (secret) safe = safe.split(String(secret)).join("[REDACTED]");
  }
  safe = safe
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=_-]+/gi, "[IMAGE_REDACTED]")
    .replace(/([?&](?:token|key|signature|sig)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/([\"']?(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret)[\"']?\s*[:=]\s*[\"']?)[^\"',\s}]+/gi, "$1[REDACTED]");
  if (safe.length > MAX_ERROR_LENGTH) safe = `${safe.slice(0, MAX_ERROR_LENGTH)}…`;
  return safe;
}

function safeUrlForLog(value) {
  try {
    const parsed = new URL(String(value));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

function validatePrompt(value, label = "Prompt") {
  if (typeof value !== "string") throw new AppError("INVALID_PROMPT", `${label} 必须是字符串。` );
  const prompt = value.trim();
  if (!prompt) throw new AppError("INVALID_PROMPT", `${label} 不能为空。` );
  if (prompt.length > MAX_PROMPT_LENGTH) throw new AppError("INVALID_PROMPT", `${label} 不能超过 ${MAX_PROMPT_LENGTH} 个字符。` );
  return value;
}

function validatePrompts(prompts, { max = 20 } = {}) {
  if (!Array.isArray(prompts) || !prompts.length) {
    throw new AppError("INVALID_PROMPTS", "Prompt 列表不能为空。" );
  }
  if (prompts.length > max) throw new AppError("INVALID_PROMPTS", `最多支持 ${max} 个 prompt。` );
  prompts.forEach((prompt, index) => validatePrompt(prompt, `Prompt #${index + 1}`));
  return prompts;
}

function parseInteger(value, label, min, max) {
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("INVALID_ARGUMENT", `${label} 必须是 ${min}~${max} 的整数。` );
  }
  return parsed;
}

function resolveSize(quality, ratio) {
  return SIZE_MATRIX[quality?.toUpperCase()]?.[ratio?.toLowerCase()] || null;
}

function normalizeQuickMode(mode = {}) {
  if (!isPlainObject(mode)) throw new AppError("INVALID_CONFIG", "quickMode 配置必须是对象。" );
  const quality = String(mode.quality ?? DEFAULTS.quality).toUpperCase();
  const ratio = String(mode.ratio ?? DEFAULTS.ratio).toLowerCase();
  const count = parseInteger(mode.count ?? DEFAULTS.count, "快速模式数量", 1, 4);
  if (!resolveSize(quality, ratio)) throw new AppError("INVALID_CONFIG", `不支持的画质或比例: ${quality}/${ratio}。` );
  return { quality, ratio, count };
}

function normalizeBatchMode(mode = {}) {
  if (!isPlainObject(mode)) throw new AppError("INVALID_CONFIG", "batchMode 配置必须是对象。" );
  const quality = String(mode.quality ?? DEFAULTS.quality).toUpperCase();
  const ratio = String(mode.ratio ?? DEFAULTS.ratio).toLowerCase();
  const concurrency = parseInteger(mode.concurrency ?? DEFAULTS.concurrency, "批量并发数", 1, 10);
  if (!resolveSize(quality, ratio)) throw new AppError("INVALID_CONFIG", `不支持的画质或比例: ${quality}/${ratio}。` );
  return { quality, ratio, concurrency };
}

function validateConfig(input) {
  if (!isPlainObject(input)) throw new AppError("INVALID_CONFIG", "配置文件根节点必须是对象。" );
  const config = { ...input };
  if (config.apiKey !== undefined) config.apiKey = normalizeApiKey(config.apiKey);
  if (config.allowInsecureApiBase !== undefined && typeof config.allowInsecureApiBase !== "boolean") {
    throw new AppError("INVALID_CONFIG", "allowInsecureApiBase 必须是布尔值。" );
  }
  if (config.apiBase !== undefined) {
    config.apiBase = normalizeBaseUrl(config.apiBase, { allowInsecure: config.allowInsecureApiBase === true });
  }
  if (config.quickMode !== undefined) config.quickMode = normalizeQuickMode(config.quickMode);
  if (config.batchMode !== undefined) config.batchMode = normalizeBatchMode(config.batchMode);
  return config;
}

function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new AppError("CONFIG_INVALID", `配置文件损坏，请修复或删除：${configPath}`, { cause: error });
  }
  return validateConfig(parsed);
}

function setPrivateFileMode(filePath) {
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
}

function replaceFileAtomically(tempPath, targetPath) {
  try {
    renameSync(tempPath, targetPath);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !existsSync(targetPath)) throw error;
  }

  const backupPath = `${targetPath}.bak`;
  copyFileSync(targetPath, backupPath);
  setPrivateFileMode(backupPath);
  unlinkSync(targetPath);
  try {
    renameSync(tempPath, targetPath);
  } catch (error) {
    copyFileSync(backupPath, targetPath);
    setPrivateFileMode(targetPath);
    throw error;
  }
}

function saveConfig(config) {
  const normalized = validateConfig(config);
  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    setPrivateFileMode(tempPath);
    replaceFileAtomically(tempPath, configPath);
    setPrivateFileMode(configPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function keyPreview(key) {
  if (!key) return null;
  const value = String(key);
  if (value.length <= 12) return `${value.slice(0, 3)}...${value.slice(-2)}`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function getApiKey(config) {
  const key = configuredApiKey(config);
  if (!key) throw new AppError("MISSING_API_KEY", "未配置 API Key。请使用环境变量或 --set-key-stdin。" );
  return key;
}

function resolveOutputDir(userDir) {
  const outputDir = resolvePath(userDir || getDefaultOutputDir());
  mkdirSync(outputDir, { recursive: true });
  if (!statSync(outputDir).isDirectory()) throw new AppError("INVALID_OUTPUT_DIR", `输出路径不是目录：${outputDir}` );
  return outputDir;
}

function timestamp() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function retryDelayMs(attempt, retryAfterMs) {
  const configuredBase = Number(process.env.SUBKKAI_IMAGE_GEN_RETRY_BASE_MS || 400);
  const base = Number.isFinite(configuredBase) && configuredBase >= 0 ? configuredBase : 400;
  const exponential = Math.min(8_000, base * 2 ** attempt);
  const serverDelay = Number.isFinite(retryAfterMs) ? Math.min(30_000, Math.max(0, retryAfterMs)) : null;
  if (serverDelay !== null) return serverDelay;
  if (process.env.SUBKKAI_IMAGE_GEN_NO_JITTER === "1") return exponential;
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

function parseRetryAfter(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1_000;
  const timestampValue = Date.parse(value);
  return Number.isFinite(timestampValue) ? Math.max(0, timestampValue - Date.now()) : null;
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError("NETWORK_TIMEOUT", `请求超时（${Math.round(timeoutMs / 1_000)} 秒）。`, { cause: error });
    }
    throw new AppError("NETWORK_ERROR", `网络请求失败：${sanitizeText(error?.message || error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytes(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError("RESPONSE_TOO_LARGE", `响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制。` );
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new AppError("RESPONSE_TOO_LARGE", "响应超过大小限制。" );
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("RESPONSE_TOO_LARGE", "响应超过大小限制。" );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function errorMessageFromBody(body, apiKey) {
  try {
    const parsed = JSON.parse(body);
    const errorValue = parsed?.error;
    const errorCode = typeof errorValue === "object" ? errorValue?.code : parsed?.code;
    const errorMessage = typeof errorValue === "string"
      ? errorValue
      : errorValue?.message || parsed?.message || parsed?.detail || body;
    const detail = errorCode ? `${errorCode}: ${errorMessage}` : errorMessage;
    return sanitizeText(detail, [apiKey]);
  } catch {
    return sanitizeText(body, [apiKey]);
  }
}

async function requestJson(url, options = {}, {
  apiKey = "",
  retries = 0,
  retryable = false,
  timeoutMs = REQUEST_TIMEOUT_MS,
  deadline = null,
} = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const canRetry = retryable || method === "GET" || method === "HEAD";
  let attempt = 0;

  while (true) {
    const remaining = deadline === null ? timeoutMs : deadline - Date.now();
    if (remaining <= 0) throw new AppError("NETWORK_TIMEOUT", "请求超过了任务总时限。" );
    let response;
    try {
      response = await fetchWithTimeout(url, options, Math.min(timeoutMs, remaining));
    } catch (error) {
      if (canRetry && attempt < retries) {
        const waitMs = retryDelayMs(attempt);
        if (deadline !== null && Date.now() + waitMs >= deadline) throw error;
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw error;
    }

    const body = (await readResponseBytes(response, MAX_JSON_BYTES)).toString("utf8");
    if (!response.ok) {
      if (canRetry && attempt < retries && RETRYABLE_STATUSES.has(response.status)) {
        const waitMs = retryDelayMs(attempt, parseRetryAfter(response));
        if (deadline !== null && Date.now() + waitMs >= deadline) {
          throw new AppError("HTTP_ERROR", `HTTP ${response.status}: ${errorMessageFromBody(body, apiKey)}`, { status: response.status });
        }
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      throw new AppError("HTTP_ERROR", `HTTP ${response.status}: ${errorMessageFromBody(body, apiKey)}`, { status: response.status });
    }
    if (!body.trim()) throw new AppError("EMPTY_RESPONSE", `HTTP ${response.status}: 响应为空。` );
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new AppError("INVALID_RESPONSE", `HTTP ${response.status}: 响应不是有效 JSON。`, { cause: error });
    }
  }
}

function extractTaskId(payload) {
  const candidates = [
    payload?.id,
    payload?.task_id,
    payload?.taskId,
    payload?.data?.id,
    payload?.data?.task_id,
    payload?.data?.taskId,
    payload?.data?.task?.id,
  ];
  const taskId = candidates.find((value) => typeof value === "string" && value.trim());
  return taskId?.trim() || null;
}

async function createGenerationTask({ apiBase, apiKey, prompt, size, n = 1 }) {
  validatePrompt(prompt);
  const payload = {
    model: MODEL,
    prompt,
    size,
    n: parseInteger(n, "生成数量", 1, 4),
    quality: "high",
    moderation: "auto",
    output_format: "png",
    stream: false,
  };
  const result = await requestJson(`${apiBase}/v1/image-tasks/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
    body: JSON.stringify(payload),
  }, { apiKey });
  const taskId = extractTaskId(result);
  if (!taskId) throw new AppError("INVALID_RESPONSE", "生成接口未返回任务 ID。" );
  return taskId;
}

function guessMimeType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  return null;
}

function detectMimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function readUInt24LE(buffer, offset) {
  if (offset < 0 || offset + 3 > buffer.length) return null;
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readJpegDimensions(buffer) {
  let offset = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer) {
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && buffer.length >= 30) {
    const width = readUInt24LE(buffer, 24);
    const height = readUInt24LE(buffer, 27);
    return width === null || height === null ? null : { width: width + 1, height: height + 1 };
  }
  if (chunkType === "VP8 " && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunkType === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readImageDimensions(buffer, mimeType = detectMimeType(buffer)) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (mimeType === "image/png" && buffer.length >= 24 && buffer.subarray(12, 16).toString("ascii") === "IHDR") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") return readJpegDimensions(buffer);
  if (mimeType === "image/webp") return readWebpDimensions(buffer);
  return null;
}

function validateImageBuffer(buffer, label = "图片") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError("INVALID_IMAGE", `${label} 为空。` );
  if (buffer.length > MAX_IMAGE_BYTES) throw new AppError("IMAGE_TOO_LARGE", `${label} 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 限制。` );
  const mimeType = detectMimeType(buffer);
  if (!mimeType) throw new AppError("INVALID_IMAGE", `${label} 不是支持的 PNG/JPEG/WebP 文件。` );
  return mimeType;
}

function readImageFile(imagePath) {
  if (!existsSync(imagePath)) throw new AppError("IMAGE_NOT_FOUND", `图片文件不存在：${imagePath}` );
  const info = statSync(imagePath);
  if (!info.isFile()) throw new AppError("INVALID_IMAGE", `图片路径不是文件：${imagePath}` );
  if (info.size > MAX_IMAGE_BYTES) throw new AppError("IMAGE_TOO_LARGE", `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 限制。` );
  const expectedMime = guessMimeType(imagePath);
  if (!expectedMime) throw new AppError("INVALID_IMAGE", "仅支持 .png、.jpg、.jpeg 和 .webp 图片。" );
  const buffer = readFileSync(imagePath);
  const actualMime = validateImageBuffer(buffer, "输入图片");
  if (actualMime !== expectedMime) {
    throw new AppError("INVALID_IMAGE", `图片扩展名与实际格式不一致：${imagePath}` );
  }
  return { buffer, mimeType: actualMime };
}

async function createEditTask({ apiBase, apiKey, imagePath, prompt, size }) {
  validatePrompt(prompt);
  const { buffer: imageBuffer, mimeType } = readImageFile(imagePath);
  const form = new FormData();
  const imageBlob = new Blob([imageBuffer], { type: mimeType });
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", "high");
  form.append("moderation", "auto");
  form.append("output_format", "png");
  form.append("image[]", imageBlob, basename(imagePath));

  const result = await requestJson(`${apiBase}/v1/image-tasks/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
    body: form,
  }, { apiKey });
  const taskId = extractTaskId(result);
  if (!taskId) throw new AppError("INVALID_RESPONSE", "编辑接口未返回任务 ID。" );
  return taskId;
}

function validateDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch (error) {
    throw new AppError("INVALID_IMAGE_URL", "图片下载地址无效。", { cause: error });
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new AppError("INVALID_IMAGE_URL", "图片下载地址只支持 http(s)。" );
  if (parsed.protocol === "http:" && !isLocalHostname(parsed.hostname) && process.env.SUBKKAI_IMAGE_GEN_ALLOW_INSECURE !== "1") {
    throw new AppError("INSECURE_IMAGE_URL", "远程图片下载必须使用 HTTPS。" );
  }
  if (parsed.username || parsed.password) throw new AppError("INVALID_IMAGE_URL", "图片下载地址不得包含凭据。" );
  return parsed.toString();
}

async function fetchImageResponse(value, { retries = 2, maxRedirects = 3 } = {}) {
  let currentUrl = validateDownloadUrl(value);
  let attempt = 0;
  let redirects = 0;

  while (true) {
    let response;
    try {
      response = await fetchWithTimeout(currentUrl, {
        redirect: "manual",
        cache: "no-store",
      }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (attempt < retries) {
        await sleep(retryDelayMs(attempt));
        attempt += 1;
        continue;
      }
      throw error;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new AppError("IMAGE_DOWNLOAD_FAILED", "图片下载重定向缺少 Location。" );
      if (redirects >= maxRedirects) throw new AppError("IMAGE_DOWNLOAD_FAILED", "图片下载重定向次数过多。" );
      await response.body?.cancel();
      currentUrl = validateDownloadUrl(new URL(location, currentUrl).toString());
      redirects += 1;
      continue;
    }

    if (response.ok) return response;
    if (attempt < retries && RETRYABLE_STATUSES.has(response.status)) {
      const waitMs = retryDelayMs(attempt, parseRetryAfter(response));
      await response.body?.cancel();
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    await response.body?.cancel();
    throw new AppError("IMAGE_DOWNLOAD_FAILED", `图片下载失败 HTTP ${response.status}。`, { status: response.status });
  }
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function createOutputPath(outputDir, prefix, extension) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = join(outputDir, `${prefix}_${timestamp()}_${randomUUID()}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new AppError("OUTPUT_COLLISION", "无法创建唯一的输出文件名。" );
}

function writeBufferAtomically(filePath, buffer) {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, buffer, { flag: "wx" });
    renameSync(tempPath, filePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

async function saveImageItem(item, outputDir, prefix) {
  let buffer;
  if (typeof item?.b64_json === "string" || typeof item?.base64 === "string") {
    const encoded = String(item.b64_json || item.base64).replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new AppError("INVALID_IMAGE", "图片 base64 数据无效。" );
    buffer = Buffer.from(encoded, encoded.includes("-") || encoded.includes("_") ? "base64url" : "base64");
  } else if (item?.url) {
    const response = await fetchImageResponse(item.url);
    buffer = await readResponseBytes(response, MAX_IMAGE_BYTES);
  } else {
    throw new AppError("INVALID_IMAGE_RESPONSE", "图片结果缺少 b64_json、base64 或 url。" );
  }

  const mimeType = validateImageBuffer(buffer, "输出图片");
  const dimensions = readImageDimensions(buffer, mimeType);
  const filePath = createOutputPath(outputDir, prefix, extensionForMimeType(mimeType));
  writeBufferAtomically(filePath, buffer);
  return {
    path: filePath,
    bytes: buffer.length,
    fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    dimensions: dimensions ? `${dimensions.width}x${dimensions.height}` : null,
  };
}

function extractTaskStatus(task) {
  return String(
    task?.status ||
    task?.data?.status ||
    task?.data?.task?.status ||
    task?.task?.status ||
    "",
  ).toLowerCase();
}

function extractTaskError(task, apiKey = "") {
  const errorValue = task?.error || task?.data?.error;
  const code = typeof errorValue === "object" ? errorValue?.code : task?.code;
  const message = typeof errorValue === "string"
    ? errorValue
    : errorValue?.message || task?.message || "上游任务失败。";
  return sanitizeText(code ? `${code}: ${message}` : message, [apiKey]);
}

async function pollTask({
  apiBase,
  apiKey,
  taskId,
  progressStartedAt = Date.now(),
  activityLabel = "生成中",
  liveProgress = null,
  reportProgress = true,
}) {
  const pollStartedAt = Date.now();
  const deadline = pollStartedAt + TASK_TIMEOUT_MS;
  let delay = INITIAL_POLL_MS;
  let progressReport = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const task = await requestJson(`${apiBase}/v1/image-tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    }, {
      apiKey,
      retries: 3,
      retryable: true,
      timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      deadline,
    });

    const status = extractTaskStatus(task);
    if (["succeeded", "success", "completed"].includes(status)) return task;
    if (["failed", "canceled", "cancelled", "error", "expired", "rejected"].includes(status)) {
      throw new AppError("TASK_FAILED", `Task ${status}: ${extractTaskError(task, apiKey)}` );
    }
    if (liveProgress) liveProgress.update(status, task);
    else if (reportProgress) {
      progressReport = reportTaskProgress(status, task, progressStartedAt, progressReport, Date.now(), activityLabel);
    }

    const waitMs = Math.min(delay, Math.max(0, deadline - Date.now()));
    await sleep(process.env.SUBKKAI_IMAGE_GEN_NO_JITTER === "1" ? waitMs : Math.round(waitMs * (0.8 + Math.random() * 0.4)));
    delay = Math.min(Math.round(delay * 1.45), MAX_POLL_MS);
  }
  throw new AppError("TASK_TIMEOUT", `任务超过 ${Math.round(TASK_TIMEOUT_MS / 1_000)} 秒仍未完成：${sanitizeText(taskId)}` );
}

function extractImageItems(task) {
  const candidates = [
    task?.response?.data,
    task?.response?.images,
    task?.data?.response?.data,
    task?.data?.response?.images,
    task?.result?.data,
    task?.result?.images,
    task?.data,
    task?.images,
  ];
  return candidates.find(Array.isArray) || [];
}

function friendlyErrorMessage(error, secrets = []) {
  const code = error?.code || "ERROR";
  const raw = sanitizeText(error?.message || error, secrets);
  if (/prompt_unsafe/i.test(raw)) return "上游安全策略拒绝了这个 prompt，请改写为更中性的描述。";
  if (/bad_size/i.test(raw)) return "上游不支持当前尺寸，请改用 1K/2K/4K 与 square/landscape/portrait 的组合。";
  if (/No available compatible accounts/i.test(raw)) return "上游暂时没有可用生图资源，请等待约 30 秒后重试。";
  if (code === "TASK_TIMEOUT") return `${raw} 远端任务可能仍在运行，请稍后查询或确认后再重试。`;
  if (code === "NETWORK_TIMEOUT") return `${raw} 请检查网络或稍后重试。`;
  if (code === "MISSING_API_KEY") return `${raw} 可使用 SUBKKAI_IMAGE_GEN_API_KEY，或通过 stdin 配置。`;
  if (code === "INVALID_PROMPT") return `${raw} 请提供非空且不超过 ${MAX_PROMPT_LENGTH} 个字符的描述。`;
  if (code === "IMAGE_TOO_LARGE") return `${raw} 请压缩图片后再编辑。`;
  return raw;
}

const TASK_STATUS_LABELS = {
  queued: "排队中",
  pending: "等待资源",
  processing: "生成中",
  running: "生成中",
  in_progress: "生成中",
};

function extractTaskProgress(task) {
  const progressValue = task?.progress ?? task?.data?.progress ?? task?.data?.task?.progress;
  const parsedProgress = Number(progressValue);
  return Number.isFinite(parsedProgress) && parsedProgress >= 0 && parsedProgress <= 100
    ? Math.round(parsedProgress)
    : null;
}

function taskStatusLabel(status, activityLabel = "生成中") {
  if (["processing", "running", "in_progress"].includes(status)) return activityLabel;
  return TASK_STATUS_LABELS[status] || "处理中";
}

function formatElapsedTime(startedAt, now = Date.now()) {
  const totalSeconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function createLiveProgress({
  startedAt = Date.now(),
  activityLabel = "生成中",
  output = process.stdout,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (output?.isTTY !== true) return null;
  let currentStatus = "processing";
  let currentProgress = null;
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const parts = [`⏳ ${taskStatusLabel(currentStatus, activityLabel)}`];
    if (currentProgress !== null) parts.push(`${currentProgress}%`);
    parts.push(formatElapsedTime(startedAt, now()));
    output.write(`\x1b[2K\r${parts.join(" · ")}`);
  };

  render();
  const timer = setIntervalFn(render, 1_000);
  timer?.unref?.();

  return {
    update(status, task) {
      if (status) currentStatus = status;
      currentProgress = extractTaskProgress(task);
      render();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      output.write("\x1b[2K\r");
    },
  };
}

function reportTaskProgress(
  status,
  task,
  startedAt,
  previousReport = null,
  now = Date.now(),
  activityLabel = "生成中",
) {
  if (!status || ["succeeded", "success", "completed"].includes(status)) return previousReport;
  const progress = extractTaskProgress(task);
  const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  const initialSilentGeneration = !previousReport
    && ["processing", "running", "in_progress"].includes(status)
    && elapsedSeconds < 1;
  if (initialSilentGeneration) return { status, progress, reportedAt: now };
  const statusChanged = status !== previousReport?.status;
  const heartbeatDue = previousReport && now - previousReport.reportedAt >= PROGRESS_HEARTBEAT_MS;
  if (!statusChanged && !heartbeatDue) return previousReport;
  const parts = [`⏳ ${taskStatusLabel(status, activityLabel)}`];
  if (progress !== null) parts.push(`${progress}%`);
  if (elapsedSeconds > 0) parts.push(formatElapsedTime(startedAt, now));
  console.log(parts.join(" · "));
  return { status, progress, reportedAt: now };
}

async function runGeneration({
  apiBase,
  apiKey,
  prompt,
  size,
  outputDir,
  prefix = "img",
  progressOutput = true,
}) {
  const startedAt = Date.now();
  const liveProgress = progressOutput && !verboseOutputEnabled()
    ? createLiveProgress({ startedAt, activityLabel: "生成中" })
    : null;
  try {
    const taskId = await createGenerationTask({ apiBase, apiKey, prompt, size, n: 1 });
    if (verboseOutputEnabled()) console.log(`🆔 任务: ${taskId}`);
    const task = await pollTask({
      apiBase,
      apiKey,
      taskId,
      progressStartedAt: startedAt,
      activityLabel: "生成中",
      liveProgress,
      reportProgress: progressOutput,
    });
    const items = extractImageItems(task);
    if (!items.length) throw new AppError("INVALID_IMAGE_RESPONSE", "生成任务完成，但响应中没有图片数据。" );
    const saved = [];
    for (const item of items) saved.push(await saveImageItem(item, outputDir, prefix));
    return { elapsed: Date.now() - startedAt, taskId, saved };
  } finally {
    liveProgress?.stop();
  }
}

async function runEdit({ apiBase, apiKey, imagePath, prompt, size, outputDir }) {
  const startedAt = Date.now();
  const liveProgress = verboseOutputEnabled()
    ? null
    : createLiveProgress({ startedAt, activityLabel: "编辑中" });
  try {
    const taskId = await createEditTask({ apiBase, apiKey, imagePath, prompt, size });
    if (verboseOutputEnabled()) console.log(`🆔 任务: ${taskId}`);
    const task = await pollTask({
      apiBase,
      apiKey,
      taskId,
      progressStartedAt: startedAt,
      activityLabel: "编辑中",
      liveProgress,
    });
    const items = extractImageItems(task);
    if (!items.length) throw new AppError("INVALID_IMAGE_RESPONSE", "编辑任务完成，但响应中没有图片数据。" );
    const saved = [];
    for (const item of items) saved.push(await saveImageItem(item, outputDir, "edit"));
    return { elapsed: Date.now() - startedAt, taskId, saved };
  } finally {
    liveProgress?.stop();
  }
}

function verboseOutputEnabled() {
  return process.env.SUBKKAI_IMAGE_GEN_VERBOSE === "1";
}

function compactPromptPreview(prompt, maxLength = 48) {
  const normalized = sanitizeText(prompt).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function markdownImage(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").replaceAll("<", "%3C").replaceAll(">", "%3E");
  return `![Subkkai result](<${normalized}>)`;
}

function dimensionStatus(saved, requestedSize) {
  const dimensions = [...new Set(saved.map((file) => file.dimensions).filter(Boolean))];
  if (!dimensions.length) return "";
  if (dimensions.length === 1 && dimensions[0] === requestedSize) return ` · ${dimensions[0]}`;
  return ` · ⚠️ 实际 ${dimensions.join(", ")}（请求 ${requestedSize}）`;
}

function savedFileLine(marker, file) {
  const details = [file.fileSize];
  if (file.dimensions) details.push(file.dimensions);
  return `${marker} ${file.path} ｜ ${details.join(" ｜ ")}`;
}

function promptPreview(prompt) {
  if (verboseOutputEnabled()) return `: "${sanitizeText(prompt).slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`;
  return "";
}

async function runBatch({ apiBase, apiKey, prompts, size, concurrency, outputDir }) {
  validatePrompts(prompts);
  const workerCount = Math.max(1, Math.min(parseInteger(concurrency, "并发数", 1, 10), prompts.length));
  const results = new Array(prompts.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < prompts.length) {
      const index = nextIndex++;
      const prompt = prompts[index];
      console.log(`[${index + 1}/${prompts.length}] 生成中${promptPreview(prompt)}`);
      try {
        const result = await runGeneration({
          apiBase,
          apiKey,
          prompt,
          size,
          outputDir,
          prefix: `img_${String(index + 1).padStart(2, "0")}`,
          progressOutput: false,
        });
        results[index] = { prompt, ok: true, ...result };
        console.log(`✅ [${index + 1}/${prompts.length}] ${(result.elapsed / 1_000).toFixed(1)}s${dimensionStatus(result.saved, size)}`);
      } catch (error) {
        results[index] = { prompt, ok: false, error: friendlyErrorMessage(error, [apiKey]) };
        console.log(`❌ [${index + 1}/${prompts.length}] ${results[index].error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const okCount = results.filter((result) => result?.ok).length;
  console.log();
  for (const [index, result] of results.entries()) {
    if (result.ok) {
      console.log(`🎨 #${index + 1} ✅`);
      for (const file of result.saved) console.log(savedFileLine("📁", file));
    } else {
      console.log(`🎨 #${index + 1} ❌ ${result.error}`);
    }
    console.log();
  }
  console.log(`✅ ${okCount}/${results.length}`);
  console.log(`📍 ${outputDir}`);
  return okCount === results.length ? 0 : 1;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new AppError("INVALID_ARGUMENT", `${flag} 缺少参数。` );
  return value;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--get-config") args.flags.getConfig = true;
    else if (arg === "--set-key") {
      args.flags.setKey = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--set-key-stdin") args.flags.setKeyStdin = true;
    else if (arg === "--set-api-base") {
      args.flags.setApiBase = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--allow-insecure-api-base") args.flags.allowInsecureApiBase = true;
    else if (arg === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (arg === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (arg === "--prompt") {
      args.prompts.push(requireValue(argv, index, arg));
      index += 1;
    }
    else if (arg === "--quality") {
      args.flags.quality = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--ratio") {
      args.flags.ratio = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--count") {
      args.flags.count = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--concurrency") {
      args.flags.concurrency = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--output-dir") {
      args.flags.outputDir = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--batch") {
      args.flags.batchFile = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--batch-inline") {
      args.flags.batchInline = true;
      let added = 0;
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        args.prompts.push(argv[++index]);
        added += 1;
      }
      if (!added) throw new AppError("INVALID_ARGUMENT", "--batch-inline 至少需要一个 prompt。" );
    } else if (arg === "--edit") args.flags.edit = true;
    else if (arg === "--latest-image") args.flags.latestImage = true;
    else if (arg === "--image") {
      args.flags.image = requireValue(argv, index, arg);
      index += 1;
    }
    else if (arg === "--verbose") args.flags.verbose = true;
    else if (arg === "--help" || arg === "-h") args.flags.help = true;
    else if (arg.startsWith("--")) throw new AppError("INVALID_ARGUMENT", `未知参数：${arg}` );
    else throw new AppError("INVALID_ARGUMENT", `无法识别的参数：${arg}` );
  }
  return args;
}

function printUsage() {
  console.log(`Subkkai Image Gen

CONFIG:
  --get-config
  --set-key-stdin                 从 stdin 安全读取 API Key
  --set-key <key>                 兼容旧用法，不建议用于共享终端
  --set-api-base <url> [--allow-insecure-api-base]
  --set-quick-mode --quality Q --ratio R --count N
  --set-batch-mode --quality Q --ratio R --concurrency N

GENERATE:
  --prompt "..." [--quality Q] [--ratio R] [--count N] [--output-dir D]
  --batch <file.json> [--quality Q] [--ratio R] [--concurrency N]
  --batch-inline "p1" "p2" [--quality Q] [--ratio R] [--concurrency N]
  --verbose                         显示截断后的 prompt 预览

EDIT:
  --edit --image <path> --prompt "..." [--quality Q] [--ratio R]
  --edit --latest-image --prompt "..." [--quality Q] [--ratio R]
`);
}

function resolveModeParams(flags, mode) {
  const quality = String(flags.quality ?? mode?.quality ?? DEFAULTS.quality).toUpperCase();
  const ratio = String(flags.ratio ?? mode?.ratio ?? DEFAULTS.ratio).toLowerCase();
  const size = resolveSize(quality, ratio);
  if (!size) throw new AppError("INVALID_ARGUMENT", `不支持的画质或比例：${quality}/${ratio}。` );
  return { quality, ratio, size };
}

async function readKeyFromStdin() {
  if (!process.stdin.isTTY) return normalizeApiKey(readFileSync(0, "utf8"));
  if (typeof process.stdin.setRawMode !== "function") {
    throw new AppError("INVALID_ARGUMENT", "当前终端不支持隐藏输入，请通过非 TTY stdin 管道传入 Key。" );
  }

  process.stdout.write("🔑 API Key（输入内容不会显示）: ");
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;

    function cleanup() {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    }

    function finish() {
      cleanup();
      try {
        resolve(normalizeApiKey(value));
      } catch (error) {
        reject(error);
      }
    }

    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new AppError("CANCELLED", "已取消 API Key 输入。" ));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

function readBatchPrompts(filePath) {
  if (!existsSync(filePath)) throw new AppError("INVALID_BATCH_FILE", `批量文件不存在：${filePath}` );
  const info = statSync(filePath);
  if (!info.isFile()) throw new AppError("INVALID_BATCH_FILE", `批量路径不是文件：${filePath}` );
  if (info.size > MAX_BATCH_FILE_BYTES) throw new AppError("INVALID_BATCH_FILE", "批量文件不能超过 1MB。" );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new AppError("INVALID_BATCH_FILE", `批量文件不是有效 JSON：${filePath}`, { cause: error });
  }
  const prompts = Array.isArray(parsed) ? parsed : parsed?.prompts;
  return validatePrompts(prompts);
}

function assertActionCombinations(flags) {
  if (flags.batchFile && flags.batchInline) throw new AppError("INVALID_ARGUMENT", "--batch 与 --batch-inline 不能同时使用。" );
  if (flags.edit && flags.batchFile) throw new AppError("INVALID_ARGUMENT", "--edit 不能和 --batch 同时使用。" );
  if (flags.latestImage && !flags.edit) throw new AppError("INVALID_ARGUMENT", "--latest-image 只能与 --edit 一起使用。" );
  if (flags.latestImage && flags.image) throw new AppError("INVALID_ARGUMENT", "--latest-image 与 --image 不能同时使用。" );
  if (flags.allowInsecureApiBase && flags.setApiBase === undefined) {
    throw new AppError("INVALID_ARGUMENT", "--allow-insecure-api-base 只能与 --set-api-base 一起使用。" );
  }
  const actions = [
    flags.getConfig,
    flags.setKey !== undefined,
    flags.setKeyStdin,
    flags.setApiBase !== undefined,
    flags.setQuickMode,
    flags.setBatchMode,
    flags.edit,
    flags.batchFile !== undefined,
    flags.batchInline,
  ].filter(Boolean);
  if (actions.length > 1) throw new AppError("INVALID_ARGUMENT", "一次只能执行一个配置或生成操作。" );
}

async function main(argv = process.argv.slice(2)) {
  const { prompts, flags } = parseArgs(argv);
  assertActionCombinations(flags);
  if (flags.verbose) process.env.SUBKKAI_IMAGE_GEN_VERBOSE = "1";
  const hasAction = Boolean(
    flags.getConfig ||
    flags.setKey !== undefined ||
    flags.setKeyStdin ||
    flags.setApiBase !== undefined ||
    flags.setQuickMode ||
    flags.setBatchMode ||
    flags.edit ||
    flags.batchFile ||
    flags.batchInline ||
    prompts.length,
  );
  if (flags.help || !hasAction) {
    printUsage();
    return;
  }
  const config = loadConfig();

  if (flags.getConfig) {
    const apiKey = configuredApiKey(config);
    console.log(JSON.stringify({
      hasKey: Boolean(apiKey),
      keyPreview: keyPreview(apiKey),
      quickMode: config.quickMode || null,
      batchMode: config.batchMode || null,
      apiBase: normalizeBaseUrl(config.apiBase || DEFAULT_API_BASE, { allowInsecure: config.allowInsecureApiBase === true }),
      allowInsecureApiBase: config.allowInsecureApiBase === true,
      configPath: getConfigPath(),
    }, null, 2));
    return;
  }

  if (flags.setKey !== undefined || flags.setKeyStdin) {
    config.apiKey = flags.setKeyStdin ? await readKeyFromStdin() : normalizeApiKey(flags.setKey);
    saveConfig(config);
    console.log(`✅ API Key 已保存\n🔑 Key: ${keyPreview(config.apiKey)}\n🔒 只显示打码预览，不输出完整 Key`);
    return;
  }

  if (flags.setApiBase !== undefined) {
    config.apiBase = normalizeBaseUrl(flags.setApiBase, { allowInsecure: flags.allowInsecureApiBase === true });
    config.allowInsecureApiBase = flags.allowInsecureApiBase === true;
    saveConfig(config);
    console.log(`✅ API Base 已保存: ${safeUrlForLog(config.apiBase)}`);
    return;
  }

  if (flags.setQuickMode) {
    config.quickMode = normalizeQuickMode({
      quality: flags.quality ?? config.quickMode?.quality,
      ratio: flags.ratio ?? config.quickMode?.ratio,
      count: flags.count ?? config.quickMode?.count,
    });
    saveConfig(config);
    const size = resolveSize(config.quickMode.quality, config.quickMode.ratio);
    console.log(`✅ 快速模式已设置\n🎨 分辨率档位: ${config.quickMode.quality} ${QUALITY_EMOJI[config.quickMode.quality] || ""}\n📐 比例: ${RATIO_NAMES[config.quickMode.ratio]} (${size})\n🔢 每次: ${config.quickMode.count} 张`);
    return;
  }

  if (flags.setBatchMode) {
    config.batchMode = normalizeBatchMode({
      quality: flags.quality ?? config.batchMode?.quality,
      ratio: flags.ratio ?? config.batchMode?.ratio,
      concurrency: flags.concurrency ?? config.batchMode?.concurrency,
    });
    saveConfig(config);
    const size = resolveSize(config.batchMode.quality, config.batchMode.ratio);
    console.log(`✅ 批量模式已设置\n🎨 分辨率档位: ${config.batchMode.quality} ${QUALITY_EMOJI[config.batchMode.quality] || ""}\n📐 比例: ${RATIO_NAMES[config.batchMode.ratio]} (${size})\n⚡ 并发: ${config.batchMode.concurrency}`);
    return;
  }

  if (flags.edit) {
    if (!flags.image && !flags.latestImage) {
      throw new AppError("INVALID_ARGUMENT", "--edit 需要 --image <path> 或 --latest-image。" );
    }
    if (prompts.length !== 1) throw new AppError("INVALID_ARGUMENT", "--edit 需要且只能需要一个 --prompt。" );
  } else if (flags.batchFile || flags.batchInline) {
    if (flags.batchFile && prompts.length) throw new AppError("INVALID_ARGUMENT", "--batch 模式不能同时传入 --prompt。" );
    if (flags.batchInline) validatePrompts(prompts);
  } else {
    if (prompts.length !== 1) throw new AppError("INVALID_ARGUMENT", "单图生成只能传入一个 --prompt。" );
    validatePrompt(prompts[0]);
  }

  const apiKey = getApiKey(config);
  const apiBase = normalizeBaseUrl(config.apiBase || DEFAULT_API_BASE, { allowInsecure: config.allowInsecureApiBase === true });
  const outputDir = resolveOutputDir(flags.outputDir);

  await printUpdateNotice();

  if (flags.edit) {
    const imagePath = flags.latestImage ? findLatestImage(outputDir) : resolvePath(flags.image);
    const { quality, ratio, size } = resolveModeParams(flags, config.quickMode);
    console.log(`✏️ 正在编辑 · ${quality} · ${RATIO_NAMES[ratio]} (${size})`);
    console.log(`📝 ${compactPromptPreview(prompts[0])}`);
    if (verboseOutputEnabled()) console.log(`🖼️ ${basename(imagePath)}`);
    const result = await runEdit({ apiBase, apiKey, imagePath, prompt: prompts[0], size, outputDir });
    console.log(`✅ 编辑完成 · ${(result.elapsed / 1_000).toFixed(1)}s${dimensionStatus(result.saved, size)}`);
    for (const file of result.saved) console.log(savedFileLine("📍", file));
    for (const file of result.saved) console.log(markdownImage(file.path));
    return;
  }

  const isBatch = Boolean(flags.batchFile || flags.batchInline);
  const { quality, ratio, size } = resolveModeParams(flags, isBatch ? config.batchMode : config.quickMode);

  if (flags.batchFile) {
    const batchPrompts = readBatchPrompts(flags.batchFile);
    const concurrency = parseInteger(flags.concurrency ?? config.batchMode?.concurrency ?? DEFAULTS.concurrency, "并发数", 1, 10);
    process.exitCode = await runBatch({ apiBase, apiKey, prompts: batchPrompts, size, concurrency, outputDir });
    return;
  }

  if (flags.batchInline) {
    const concurrency = parseInteger(flags.concurrency ?? config.batchMode?.concurrency ?? DEFAULTS.concurrency, "并发数", 1, 10);
    process.exitCode = await runBatch({ apiBase, apiKey, prompts, size, concurrency, outputDir });
    return;
  }

  const count = parseInteger(flags.count ?? config.quickMode?.count ?? DEFAULTS.count, "生成数量", 1, 4);
  if (count > 1) {
    process.exitCode = await runBatch({ apiBase, apiKey, prompts: Array(count).fill(prompts[0]), size, concurrency: Math.min(count, 4), outputDir });
    return;
  }

  console.log(`🎨 正在生成 · ${quality} · ${RATIO_NAMES[ratio]} (${size})`);
  console.log(`📝 ${compactPromptPreview(prompts[0])}`);
  const result = await runGeneration({ apiBase, apiKey, prompt: prompts[0], size, outputDir });
  console.log(`✅ 生成完成 · ${(result.elapsed / 1_000).toFixed(1)}s${dimensionStatus(result.saved, size)}`);
  for (const file of result.saved) console.log(savedFileLine("📍", file));
  for (const file of result.saved) console.log(markdownImage(file.path));
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolvePath(process.argv[1])).href === import.meta.url;
}

export {
  AppError,
  DEFAULTS,
  SIZE_MATRIX,
  createEditTask,
  createGenerationTask,
  createLiveProgress,
  extractImageItems,
  fetchImageResponse,
  findLatestImage,
  friendlyErrorMessage,
  loadConfig,
  main,
  markdownImage,
  normalizeBaseUrl,
  parseArgs,
  pollTask,
  readImageDimensions,
  reportTaskProgress,
  requestJson,
  resolveModeParams,
  saveConfig,
  saveImageItem,
  dimensionStatus,
  sanitizeText,
  validateConfig,
  validateImageBuffer,
  validatePrompt,
  validatePrompts,
  readBatchPrompts,
};

if (isMainModule()) {
  main().catch((error) => {
    const key = process.env.SUBKKAI_IMAGE_GEN_API_KEY || "";
    const prefix = error?.code ? `[${error.code}] ` : "";
    console.error(`❌ ${prefix}${friendlyErrorMessage(error, [key])}`);
    process.exitCode = 1;
  });
}
