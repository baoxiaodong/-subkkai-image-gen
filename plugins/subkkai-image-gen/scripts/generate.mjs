#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "https://subkkai.com";
const MODEL = "gpt-image-2";
const CONFIG_PATH = join(homedir(), ".codex", "subkkai-image-gen-config.json");
const DEFAULT_OUTPUT_DIR = join(homedir(), "Pictures", "subkkai-image-gen");
const TASK_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const STATUS_LOG_INTERVAL_MS = 15_000;

const SIZE_MATRIX = {
  "1K": { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" },
  "2K": { square: "2048x2048", landscape: "2048x1152", portrait: "1152x2048" },
  "4K": { square: "2880x2880", landscape: "3840x2160", portrait: "2160x3840" },
};

const DEFAULTS = { quality: "2K", ratio: "portrait", count: 1, concurrency: 3 };
const QUALITY_EMOJI = { "1K": "🚀", "2K": "✨", "4K": "💎" };
const RATIO_NAMES = { square: "正方形", landscape: "横版", portrait: "竖版" };

function normalizeBaseUrl(url) {
  return (url || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptPreview(prompt, maxLength = 48) {
  const normalized = String(prompt || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function markdownImage(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").replaceAll("<", "%3C").replaceAll(">", "%3E");
  return `![Subkkai result](<${normalized}>)`;
}

function createStatusTimer(label) {
  const startedAt = Date.now();
  const live = process.stdout.isTTY === true;
  let stopped = false;
  let width = 0;

  const render = () => {
    if (stopped) return;
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const line = `⏳ ${label} · ${elapsedSeconds}s`;
    const padding = " ".repeat(Math.max(0, width - line.length));
    process.stdout.write(`\r${line}${padding}`);
    width = Math.max(width, line.length);
  };

  if (live) render();
  const timer = setInterval(render, live ? 1000 : STATUS_LOG_INTERVAL_MS);
  timer?.unref?.();

  return {
    stop() {
      if (stopped) return;
      if (live) render();
      stopped = true;
      clearInterval(timer);
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (live) process.stdout.write("\n");
      else console.log(`⏳ ${label} · ${elapsedSeconds}s`);
    },
  };
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getApiKey() {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error("ERROR: API key not configured. Run --set-key <key> first.");
    process.exit(1);
  }
  return config.apiKey;
}

function keyPreview(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 3)}...${key.slice(-2)}`;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function resolveSize(quality, ratio) {
  return SIZE_MATRIX[quality?.toUpperCase()]?.[ratio?.toLowerCase()] || null;
}

function resolveOutputDir(userDir) {
  const outputDir = userDir || DEFAULT_OUTPUT_DIR;
  mkdirSync(outputDir, { recursive: true });
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

async function readError(response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.message || parsed.error || body;
  } catch {
    return body;
  }
}

function apiUrl(apiBase, route) {
  const base = normalizeBaseUrl(apiBase);
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/${route.replace(/^\/+/, "")}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    const code = error?.cause?.code || error?.code;
    const networkError = new Error(code ? `${error.message} (${code})` : error.message);
    networkError.retryable = true;
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestJson(url, options, { timeoutMs = REQUEST_TIMEOUT_MS, retries = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${await readError(response)}`);
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }
      const body = await response.text();
      if (!body.trim()) throw new Error(`HTTP ${response.status}: empty response body`);
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`HTTP ${response.status}: response was not valid JSON`);
      }
    } catch (error) {
      lastError = error;
      if (error?.retryable !== true || attempt === retries) throw error;
      await sleep(Math.min(500 * 2 ** attempt, 2_000));
    }
  }
  throw lastError;
}

function extractTaskId(payload) {
  return payload?.id || payload?.task_id || payload?.taskId || payload?.data?.id || payload?.data?.task_id;
}

function taskPollUrl(apiBase, taskId, pollUrl) {
  const normalizedBase = normalizeBaseUrl(apiBase);
  if (pollUrl) {
    try {
      const base = new URL(`${normalizedBase}/`);
      const resolved = new URL(pollUrl, base);
      if (resolved.origin === base.origin) return resolved.toString();
    } catch {
      // Fall back to the known same-origin task endpoint below.
    }
  }
  return apiUrl(apiBase, `image-tasks/${encodeURIComponent(taskId)}`);
}

async function createGenerationTask({ apiBase, apiKey, prompt, size, n = 1 }) {
  const result = await requestJson(
    apiUrl(apiBase, "image-tasks/generations"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        n,
        size,
        stream: false,
      }),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  const taskId = extractTaskId(result);
  if (!taskId) throw new Error(`No task id in generation response: ${JSON.stringify(result)}`);
  return {
    taskId,
    pollUrl: taskPollUrl(apiBase, taskId, result.poll_url),
    expiresAt: result.expires_at || null,
  };
}

async function createEditTask({ apiBase, apiKey, imagePath, prompt, size }) {
  if (!existsSync(imagePath)) throw new Error(`Image file does not exist: ${imagePath}`);

  const form = new FormData();
  const imageBuffer = readFileSync(imagePath);
  const imageBlob = new Blob([imageBuffer], { type: guessMimeType(imagePath) });
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("image[]", imageBlob, basename(imagePath));

  const result = await requestJson(
    apiUrl(apiBase, "image-tasks/edits"),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  const taskId = extractTaskId(result);
  if (!taskId) throw new Error(`No task id in edit response: ${JSON.stringify(result)}`);
  return {
    taskId,
    pollUrl: taskPollUrl(apiBase, taskId, result.poll_url),
    expiresAt: result.expires_at || null,
  };
}

function guessMimeType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function pollTask({ apiBase, apiKey, taskId, pollUrl, expiresAt }) {
  const startedAt = Date.now();
  const deadline = startedAt + TASK_TIMEOUT_MS;
  let lastStatus = "unknown";
  let upstreamExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;

  while (Date.now() < deadline) {
    const task = await requestJson(
      taskPollUrl(apiBase, taskId, pollUrl),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      { timeoutMs: REQUEST_TIMEOUT_MS, retries: 2 },
    );

    const status = String(task.status || task.data?.status || "").toLowerCase();
    lastStatus = status || "unknown";
    const responseExpiry = task.expires_at || task.data?.expires_at;
    if (responseExpiry) {
      const parsed = Date.parse(responseExpiry);
      if (Number.isFinite(parsed)) upstreamExpiry = parsed;
    }

    if (status === "succeeded" || status === "success" || status === "completed") return task;
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      const rawError = task.error?.message || task.error || task.message || task;
      const message = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
      throw new Error(`Task ${taskId} ${status}: ${message}`);
    }
    if (Number.isFinite(upstreamExpiry) && Date.now() >= upstreamExpiry) {
      throw new Error(`Task expired upstream: ${taskId} (last status: ${lastStatus})`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Task timeout after ${Math.round(TASK_TIMEOUT_MS / 1000)}s: ${taskId} (last status: ${lastStatus})`);
}

async function createAndPollTask(createTask, retryLabel) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const taskInfo = await createTask();
    try {
      const task = await pollTask({ ...taskInfo });
      return { taskInfo, task };
    } catch (error) {
      const skippedMainline = /skipped_mainline/i.test(error.message);
      if (!skippedMainline || attempt === 1) throw error;
      console.log(`⚠️ 上游跳过本次${retryLabel}，正在安全重试一次...`);
      await sleep(1_000);
    }
  }
  throw new Error(`Unexpected ${retryLabel} retry state`);
}

function extractImageItems(payload) {
  const candidates = [
    payload?.data,
    payload?.images,
    payload?.response?.data,
    payload?.result?.data,
    payload?.result?.images,
  ];
  return candidates.find(Array.isArray) || [];
}

async function fetchImageBuffer(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {}, DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(800 * attempt);
    }
  }
  throw new Error(`Download failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`);
}

async function saveImageItem(item, outputDir, prefix) {
  const filename = `${prefix}_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.png`;
  const filepath = join(outputDir, filename);

  if (item.b64_json || item.base64) {
    const buffer = Buffer.from(item.b64_json || item.base64, "base64");
    writeFileSync(filepath, buffer);
    return { path: filepath, fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB` };
  }

  if (item.url) {
    const buffer = await fetchImageBuffer(item.url);
    writeFileSync(filepath, buffer);
    return { path: filepath, fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB` };
  }

  throw new Error(`No b64_json/base64/url in image item: ${JSON.stringify(item)}`);
}

async function runGeneration({ apiBase, apiKey, prompt, size, outputDir }) {
  const start = Date.now();
  const { taskInfo, task } = await createAndPollTask(
    async () => {
      const created = await createGenerationTask({ apiBase, apiKey, prompt, size, n: 1 });
      return { apiBase, apiKey, ...created };
    },
    "生成",
  );
  const items = extractImageItems(task);
  if (!items.length) throw new Error(`No image data in generation task: ${JSON.stringify(task)}`);
  const saved = [];
  for (const item of items) saved.push(await saveImageItem(item, outputDir, "img"));
  return { elapsed: Date.now() - start, taskId: taskInfo.taskId, saved };
}

async function runEdit({ apiBase, apiKey, imagePath, prompt, size, outputDir }) {
  const start = Date.now();
  const { taskInfo, task } = await createAndPollTask(
    async () => {
      const created = await createEditTask({ apiBase, apiKey, imagePath, prompt, size });
      return { apiBase, apiKey, ...created };
    },
    "编辑",
  );
  const items = extractImageItems(task);
  if (!items.length) throw new Error(`No image data in edit task: ${JSON.stringify(task)}`);
  const saved = [];
  for (const item of items) saved.push(await saveImageItem(item, outputDir, "edit"));
  return { elapsed: Date.now() - start, taskId: taskInfo.taskId, saved };
}

async function runBatch({ apiBase, apiKey, prompts, size, concurrency, outputDir }) {
  if (prompts.length > 20) throw new Error("Maximum batch size is 20 prompts.");
  const results = new Array(prompts.length);
  let nextIndex = 0;
  const startedAt = Date.now();

  async function worker() {
    while (nextIndex < prompts.length) {
      const index = nextIndex++;
      const prompt = prompts[index];
      console.log(`[${index + 1}/${prompts.length}] 生成中: "${prompt.slice(0, 30)}${prompt.length > 30 ? "..." : ""}"`);
      try {
        const result = await runGeneration({ apiBase, apiKey, prompt, size, outputDir });
        results[index] = { prompt, ok: true, ...result };
        console.log(`✅ [${index + 1}/${prompts.length}] ${(result.elapsed / 1000).toFixed(1)}s`);
      } catch (error) {
        results[index] = { prompt, ok: false, error: error.message };
        console.log(`❌ [${index + 1}/${prompts.length}] ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, () => worker()));
  const elapsed = Date.now() - startedAt;
  const ok = results.filter((result) => result.ok);

  console.log();
  for (const result of results) {
    if (result.ok) {
      console.log(`🎨 "${result.prompt}" ✅`);
      for (const file of result.saved) console.log(`📁 ${file.path} ｜ ${file.fileSize}`);
    } else {
      console.log(`🎨 "${result.prompt}" ❌ ${result.error}`);
    }
    console.log();
  }
  console.log(`✅ ${ok.length}/${results.length} ｜ ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`📍 ${outputDir}`);
  return ok.length === results.length ? 0 : 1;
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--get-config") args.flags.getConfig = true;
    else if (arg === "--set-key" && argv[index + 1]) args.flags.setKey = argv[++index];
    else if (arg === "--set-api-base" && argv[index + 1]) args.flags.setApiBase = argv[++index];
    else if (arg === "--set-quick-mode") args.flags.setQuickMode = true;
    else if (arg === "--set-batch-mode") args.flags.setBatchMode = true;
    else if (arg === "--prompt" && argv[index + 1]) args.prompts.push(argv[++index]);
    else if (arg === "--quality" && argv[index + 1]) args.flags.quality = argv[++index];
    else if (arg === "--ratio" && argv[index + 1]) args.flags.ratio = argv[++index];
    else if (arg === "--count" && argv[index + 1]) args.flags.count = Number.parseInt(argv[++index], 10);
    else if (arg === "--concurrency" && argv[index + 1]) args.flags.concurrency = Number.parseInt(argv[++index], 10);
    else if (arg === "--output-dir" && argv[index + 1]) args.flags.outputDir = argv[++index];
    else if (arg === "--batch" && argv[index + 1]) args.flags.batchFile = argv[++index];
    else if (arg === "--batch-inline") {
      args.flags.batchInline = true;
      index++;
      while (index < argv.length && !argv[index].startsWith("--")) args.prompts.push(argv[index++]);
      index--;
    }
    else if (arg === "--edit") args.flags.edit = true;
    else if (arg === "--image" && argv[index + 1]) args.flags.image = argv[++index];
    else if (arg === "--help" || arg === "-h") args.flags.help = true;
  }
  return args;
}

function printUsage() {
  console.log(`Subkkai Image Gen

CONFIG:
  --get-config
  --set-key <key>
  --set-api-base <url>
  --set-quick-mode --quality Q --ratio R --count N
  --set-batch-mode --quality Q --ratio R --concurrency N

GENERATE:
  --prompt "..." [--quality Q] [--ratio R] [--count N] [--output-dir D]
  --batch <file.json> [--quality Q] [--ratio R] [--concurrency N]
  --batch-inline "p1" "p2" [--quality Q] [--ratio R] [--concurrency N]

EDIT:
  --edit --image <path> --prompt "..." [--quality Q] [--ratio R]
`);
}

function resolveModeParams(flags, mode) {
  const quality = (flags.quality || mode?.quality || DEFAULTS.quality).toUpperCase();
  const ratio = (flags.ratio || mode?.ratio || DEFAULTS.ratio).toLowerCase();
  const size = resolveSize(quality, ratio);
  if (!size) throw new Error(`Invalid quality="${quality}" or ratio="${ratio}".`);
  return { quality, ratio, size };
}

async function main(argv = process.argv.slice(2)) {
  const { prompts, flags } = parseArgs(argv);
  const config = loadConfig() || {};
  const apiBase = normalizeBaseUrl(config.apiBase || DEFAULT_API_BASE);

  if (flags.getConfig) {
    console.log(JSON.stringify({
      hasKey: !!config.apiKey,
      keyPreview: keyPreview(config.apiKey),
      quickMode: config.quickMode || null,
      batchMode: config.batchMode || null,
      apiBase,
      transport: "task-fast",
    }, null, 2));
    return;
  }

  if (flags.setKey) {
    config.apiKey = flags.setKey;
    saveConfig(config);
    console.log(`✅ API Key 已保存\n🔑 Key: ${keyPreview(flags.setKey)}\n🔒 已保存到本地配置`);
    return;
  }

  if (flags.setApiBase) {
    config.apiBase = normalizeBaseUrl(flags.setApiBase);
    saveConfig(config);
    console.log(`✅ API Base 已保存: ${config.apiBase}`);
    return;
  }

  if (flags.setQuickMode) {
    config.quickMode = {
      quality: (flags.quality || config.quickMode?.quality || DEFAULTS.quality).toUpperCase(),
      ratio: (flags.ratio || config.quickMode?.ratio || DEFAULTS.ratio).toLowerCase(),
      count: Math.max(1, Math.min(flags.count || config.quickMode?.count || DEFAULTS.count, 4)),
    };
    saveConfig(config);
    const size = resolveSize(config.quickMode.quality, config.quickMode.ratio);
    console.log(`✅ 快速模式已设置\n🎨 画质: ${config.quickMode.quality} ${QUALITY_EMOJI[config.quickMode.quality] || ""}\n📐 比例: ${RATIO_NAMES[config.quickMode.ratio] || config.quickMode.ratio} (${size})\n🔢 每次: ${config.quickMode.count} 张`);
    return;
  }

  if (flags.setBatchMode) {
    config.batchMode = {
      quality: (flags.quality || config.batchMode?.quality || DEFAULTS.quality).toUpperCase(),
      ratio: (flags.ratio || config.batchMode?.ratio || DEFAULTS.ratio).toLowerCase(),
      concurrency: Math.max(1, Math.min(flags.concurrency || config.batchMode?.concurrency || DEFAULTS.concurrency, 10)),
    };
    saveConfig(config);
    const size = resolveSize(config.batchMode.quality, config.batchMode.ratio);
    console.log(`✅ 批量模式已设置\n🎨 画质: ${config.batchMode.quality} ${QUALITY_EMOJI[config.batchMode.quality] || ""}\n📐 比例: ${RATIO_NAMES[config.batchMode.ratio] || config.batchMode.ratio} (${size})\n⚡ 并发: ${config.batchMode.concurrency}`);
    return;
  }

  if (flags.help || (!flags.edit && !flags.batchFile && !flags.batchInline && prompts.length === 0)) {
    printUsage();
    return;
  }

  const apiKey = getApiKey();
  const outputDir = resolveOutputDir(flags.outputDir);

  if (flags.edit) {
    if (!flags.image) throw new Error("--edit requires --image <path>.");
    if (!prompts.length) throw new Error("--edit requires --prompt <text>.");
    const { quality, ratio, size } = resolveModeParams(flags, config.quickMode);
    console.log(`✏️ 正在编辑 · ${quality} · ${RATIO_NAMES[ratio] || ratio} (${size})`);
    console.log(`📝 ${promptPreview(prompts[0])}`);
    console.log(`🖼️ ${basename(flags.image)}`);
    const statusTimer = createStatusTimer("编辑中");
    let result;
    try {
      result = await runEdit({ apiBase, apiKey, imagePath: flags.image, prompt: prompts[0], size, outputDir });
    } finally {
      statusTimer.stop();
    }
    console.log(`✅ 编辑完成 · ${(result.elapsed / 1000).toFixed(1)}s`);
    for (const file of result.saved) console.log(`📍 ${file.path} ｜ ${file.fileSize}`);
    for (const file of result.saved) console.log(markdownImage(file.path));
    return;
  }

  const isBatch = !!flags.batchFile || !!flags.batchInline;
  const { quality, ratio, size } = resolveModeParams(flags, isBatch ? config.batchMode : config.quickMode);

  if (flags.batchFile) {
    const parsed = JSON.parse(readFileSync(flags.batchFile, "utf-8"));
    const batchPrompts = Array.isArray(parsed) ? parsed : parsed.prompts;
    if (!Array.isArray(batchPrompts) || !batchPrompts.length) throw new Error("Batch file must contain a JSON array or { prompts: [] }.");
    const concurrency = Math.max(1, Math.min(flags.concurrency || config.batchMode?.concurrency || DEFAULTS.concurrency, 10));
    process.exitCode = await runBatch({ apiBase, apiKey, prompts: batchPrompts, size, concurrency, outputDir });
    return;
  }

  if (flags.batchInline) {
    if (!prompts.length) throw new Error("--batch-inline requires at least one prompt.");
    const concurrency = Math.max(1, Math.min(flags.concurrency || config.batchMode?.concurrency || DEFAULTS.concurrency, 10));
    process.exitCode = await runBatch({ apiBase, apiKey, prompts, size, concurrency, outputDir });
    return;
  }

  const count = Math.max(1, Math.min(flags.count || config.quickMode?.count || DEFAULTS.count, 4));
  const prompt = prompts[0];
  if (count > 1) {
    process.exitCode = await runBatch({ apiBase, apiKey, prompts: Array(count).fill(prompt), size, concurrency: Math.min(count, 4), outputDir });
    return;
  }

  console.log(`🎨 正在生成 · ${quality} · ${RATIO_NAMES[ratio] || ratio} (${size})`);
  console.log(`📝 ${promptPreview(prompt)}`);
  const statusTimer = createStatusTimer("生成中");
  let result;
  try {
    result = await runGeneration({ apiBase, apiKey, prompt, size, outputDir });
  } finally {
    statusTimer.stop();
  }
  console.log(`✅ 生成完成 · ${(result.elapsed / 1000).toFixed(1)}s`);
  for (const file of result.saved) console.log(`📍 ${file.path} ｜ ${file.fileSize}`);
  for (const file of result.saved) console.log(markdownImage(file.path));
}

function isMainModule() {
  return !!process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  apiUrl,
  createEditTask,
  createGenerationTask,
  extractImageItems,
  main,
  parseArgs,
  pollTask,
  requestJson,
  resolveModeParams,
  runEdit,
  runGeneration,
  taskPollUrl,
};
