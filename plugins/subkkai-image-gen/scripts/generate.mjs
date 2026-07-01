#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "https://subkkai.com";
const MODEL = "gpt-image-2";
const CONFIG_PATH = join(homedir(), ".codex", "subkkai-image-gen-config.json");
const DEFAULT_OUTPUT_DIR = join(homedir(), "Pictures", "subkkai-image-gen");
const TASK_TIMEOUT_MS = 300_000;
const INITIAL_POLL_MS = 700;
const MAX_POLL_MS = 8_000;

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

function extractTaskId(payload) {
  return payload?.id || payload?.task_id || payload?.taskId || payload?.data?.id || payload?.data?.task_id;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await readError(response)}`);
  }
  return response.json();
}

async function createGenerationTask({ apiBase, apiKey, prompt, size, n }) {
  const payload = {
    model: MODEL,
    prompt,
    size,
    n,
    quality: "high",
    moderation: "auto",
    output_format: "png",
    stream: false,
  };

  const result = await requestJson(`${apiBase}/v1/image-tasks/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });

  const taskId = extractTaskId(result);
  if (!taskId) throw new Error(`No task id in generation response: ${JSON.stringify(result)}`);
  return taskId;
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
  form.append("quality", "high");
  form.append("moderation", "auto");
  form.append("output_format", "png");
  form.append("image[]", imageBlob, basename(imagePath));

  const result = await requestJson(`${apiBase}/v1/image-tasks/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const taskId = extractTaskId(result);
  if (!taskId) throw new Error(`No task id in edit response: ${JSON.stringify(result)}`);
  return taskId;
}

function guessMimeType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

async function pollTask({ apiBase, apiKey, taskId }) {
  const startedAt = Date.now();
  let delay = INITIAL_POLL_MS;

  while (Date.now() - startedAt < TASK_TIMEOUT_MS) {
    const task = await requestJson(`${apiBase}/v1/image-tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const status = String(task.status || task.data?.status || "").toLowerCase();
    if (status === "succeeded" || status === "success" || status === "completed") return task;
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      const message = task.error?.message || task.error || task.message || JSON.stringify(task);
      throw new Error(`Task ${status}: ${message}`);
    }

    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.45), MAX_POLL_MS);
  }

  throw new Error(`Task timeout after ${Math.round(TASK_TIMEOUT_MS / 1000)}s: ${taskId}`);
}

function extractImageItems(task) {
  const response = task.response || task.data?.response || task.result || task.data?.result || task;
  const data = response?.data || response?.images || task.images || [];
  return Array.isArray(data) ? data : [];
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
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Download failed HTTP ${response.status}: ${item.url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(filepath, buffer);
    return { path: filepath, fileSize: `${(buffer.length / 1024 / 1024).toFixed(2)}MB` };
  }

  throw new Error(`No b64_json/base64/url in image item: ${JSON.stringify(item)}`);
}

async function runGeneration({ apiBase, apiKey, prompt, size, outputDir }) {
  const start = Date.now();
  const taskId = await createGenerationTask({ apiBase, apiKey, prompt, size, n: 1 });
  console.log(`🆔 任务: ${taskId}`);
  const task = await pollTask({ apiBase, apiKey, taskId });
  const items = extractImageItems(task);
  if (!items.length) throw new Error(`No image data in task result: ${JSON.stringify(task)}`);
  const saved = [];
  for (const item of items) saved.push(await saveImageItem(item, outputDir, "img"));
  return { elapsed: Date.now() - start, taskId, saved };
}

async function runEdit({ apiBase, apiKey, imagePath, prompt, size, outputDir }) {
  const start = Date.now();
  const taskId = await createEditTask({ apiBase, apiKey, imagePath, prompt, size });
  console.log(`🆔 任务: ${taskId}`);
  const task = await pollTask({ apiBase, apiKey, taskId });
  const items = extractImageItems(task);
  if (!items.length) throw new Error(`No image data in edit result: ${JSON.stringify(task)}`);
  const saved = [];
  for (const item of items) saved.push(await saveImageItem(item, outputDir, "edit"));
  return { elapsed: Date.now() - start, taskId, saved };
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

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig() || {};
  const apiBase = normalizeBaseUrl(config.apiBase || DEFAULT_API_BASE);

  if (flags.getConfig) {
    console.log(JSON.stringify({
      hasKey: !!config.apiKey,
      keyPreview: keyPreview(config.apiKey),
      quickMode: config.quickMode || null,
      batchMode: config.batchMode || null,
      apiBase,
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
    console.log(`✏️ 编辑中: ${basename(flags.image)}`);
    console.log(`🎨 ${quality} ${RATIO_NAMES[ratio] || ratio} (${size})`);
    const result = await runEdit({ apiBase, apiKey, imagePath: flags.image, prompt: prompts[0], size, outputDir });
    console.log(`✅ ${(result.elapsed / 1000).toFixed(1)}s`);
    for (const file of result.saved) console.log(`📍 ${file.path} ｜ ${file.fileSize}`);
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

  console.log(`⏳ 生成中...`);
  console.log(`🎨 ${quality} ${RATIO_NAMES[ratio] || ratio} (${size})`);
  const result = await runGeneration({ apiBase, apiKey, prompt, size, outputDir });
  console.log(`🎨 "${prompt}"`);
  console.log(`✅ ${(result.elapsed / 1000).toFixed(1)}s`);
  for (const file of result.saved) console.log(`📍 ${file.path} ｜ ${file.fileSize}`);
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
