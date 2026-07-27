import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppError,
  createEditTask,
  createLiveProgress,
  dimensionStatus,
  findLatestImage,
  friendlyErrorMessage,
  loadConfig,
  main,
  normalizeBaseUrl,
  parseArgs,
  pollTask,
  reportTaskProgress,
  readBatchPrompts,
  requestJson,
  readImageDimensions,
  saveConfig,
  saveImageItem,
  sanitizeText,
  validatePrompt,
} from "../plugins/subkkai-image-gen/scripts/generate.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(REPO_ROOT, "plugins", "subkkai-image-gen", "scripts", "generate.mjs");
let nextTestPort = 30_000 + (process.pid % 10_000);

function freshEnv() {
  const root = mkdtempSync(join(tmpdir(), "subkkai-image-gen-test-"));
  const previous = {
    config: process.env.SUBKKAI_IMAGE_GEN_CONFIG,
    output: process.env.SUBKKAI_IMAGE_GEN_OUTPUT_DIR,
    noJitter: process.env.SUBKKAI_IMAGE_GEN_NO_JITTER,
    retryBase: process.env.SUBKKAI_IMAGE_GEN_RETRY_BASE_MS,
    apiKey: process.env.SUBKKAI_IMAGE_GEN_API_KEY,
    allowInsecure: process.env.SUBKKAI_IMAGE_GEN_ALLOW_INSECURE,
    verbose: process.env.SUBKKAI_IMAGE_GEN_VERBOSE,
    updateDisabled: process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK,
    updateUrl: process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL,
    updateCache: process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE,
    liveProgress: process.env.SUBKKAI_IMAGE_GEN_LIVE_PROGRESS,
  };
  process.env.SUBKKAI_IMAGE_GEN_CONFIG = join(root, "config.json");
  process.env.SUBKKAI_IMAGE_GEN_OUTPUT_DIR = join(root, "output");
  process.env.SUBKKAI_IMAGE_GEN_NO_JITTER = "1";
  process.env.SUBKKAI_IMAGE_GEN_RETRY_BASE_MS = "1";
  delete process.env.SUBKKAI_IMAGE_GEN_API_KEY;
  delete process.env.SUBKKAI_IMAGE_GEN_ALLOW_INSECURE;
  delete process.env.SUBKKAI_IMAGE_GEN_VERBOSE;
  process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK = "1";
  delete process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL;
  delete process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE;
  process.env.SUBKKAI_IMAGE_GEN_LIVE_PROGRESS = "0";
  return { root, previous };
}

function restoreEnv(root, previous) {
  for (const [key, value] of Object.entries({
    SUBKKAI_IMAGE_GEN_CONFIG: previous.config,
    SUBKKAI_IMAGE_GEN_OUTPUT_DIR: previous.output,
    SUBKKAI_IMAGE_GEN_NO_JITTER: previous.noJitter,
    SUBKKAI_IMAGE_GEN_RETRY_BASE_MS: previous.retryBase,
    SUBKKAI_IMAGE_GEN_API_KEY: previous.apiKey,
    SUBKKAI_IMAGE_GEN_ALLOW_INSECURE: previous.allowInsecure,
    SUBKKAI_IMAGE_GEN_VERBOSE: previous.verbose,
    SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK: previous.updateDisabled,
    SUBKKAI_IMAGE_GEN_UPDATE_URL: previous.updateUrl,
    SUBKKAI_IMAGE_GEN_UPDATE_CACHE: previous.updateCache,
    SUBKKAI_IMAGE_GEN_LIVE_PROGRESS: previous.liveProgress,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

async function startServer(handler) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch((error) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ message: error.message }));
      });
    });
    const port = nextTestPort;
    nextTestPort = nextTestPort >= 49_999 ? 30_000 : nextTestPort + 1;
    try {
      await new Promise((resolveListening, rejectListening) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectListening(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolveListening();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return {
        server,
        base: `http://127.0.0.1:${port}`,
      };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Unable to allocate a fetch-safe local test port.");
}

async function stopServer(server) {
  server.close();
  await once(server, "close");
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

describe("Subkkai Image Gen CLI", { concurrency: false }, () => {

test("normalizes API bases and rejects unsafe remote URLs", () => {
  assert.equal(normalizeBaseUrl("https://subkkai.com///"), "https://subkkai.com");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:1234///"), "http://127.0.0.1:1234");
  assert.throws(() => normalizeBaseUrl("http://example.com"), (error) => error.code === "INSECURE_API_BASE");
  assert.throws(() => normalizeBaseUrl("https://user:pass@example.com"), (error) => error.code === "INVALID_API_BASE");
  assert.throws(() => normalizeBaseUrl("https://example.com/?token=secret"), (error) => error.code === "INVALID_API_BASE");
});

test("reads PNG, JPEG, and WebP dimensions and reports mismatches", () => {
  const png = Buffer.from(PNG_BASE64, "base64");
  assert.deepEqual(readImageDimensions(png, "image/png"), { width: 1, height: 1 });

  const jpeg = Buffer.alloc(23);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03]).copy(jpeg);
  assert.deepEqual(readImageDimensions(jpeg, "image/jpeg"), { width: 3, height: 2 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[24] = 3;
  webp[27] = 4;
  assert.deepEqual(readImageDimensions(webp, "image/webp"), { width: 4, height: 5 });

  assert.equal(dimensionStatus([{ dimensions: "1024x1024" }], "1024x1024"), " · 1024x1024");
  assert.equal(dimensionStatus([{ dimensions: "1254x1254" }], "1024x1024"), " · ⚠️ 实际 1254x1254（请求 1024x1024）");
});

test("parses arguments strictly and validates prompts", () => {
  assert.deepEqual(parseArgs(["--prompt", "hello", "--count", "2"]).flags.count, "2");
  assert.equal(parseArgs(["--edit", "--latest-image", "--prompt", "hello"]).flags.latestImage, true);
  assert.throws(() => parseArgs(["--unknown"]), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => parseArgs(["--prompt"]), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => validatePrompt("   "), (error) => error.code === "INVALID_PROMPT");
  assert.throws(() => validatePrompt(42), (error) => error.code === "INVALID_PROMPT");
});

test("selects the newest supported image without scanning in Codex", () => {
  const { root, previous } = freshEnv();
  try {
    const outputDir = process.env.SUBKKAI_IMAGE_GEN_OUTPUT_DIR;
    mkdirSync(outputDir, { recursive: true });
    const oldPath = join(outputDir, "old.png");
    const latestPath = join(outputDir, "latest.webp");
    const ignoredPath = join(outputDir, "notes.txt");
    writeFileSync(oldPath, Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(latestPath, Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(ignoredPath, "newer but not an image", "utf8");
    utimesSync(oldPath, new Date(1_000), new Date(1_000));
    utimesSync(latestPath, new Date(2_000), new Date(2_000));
    utimesSync(ignoredPath, new Date(3_000), new Date(3_000));
    assert.equal(findLatestImage(outputDir), latestPath);
  } finally {
    restoreEnv(root, previous);
  }
});

test("reports immediately when no previous image exists", () => {
  const { root, previous } = freshEnv();
  try {
    assert.throws(
      () => findLatestImage(process.env.SUBKKAI_IMAGE_GEN_OUTPUT_DIR),
      (error) => error.code === "NO_IMAGE_AVAILABLE",
    );
  } finally {
    restoreEnv(root, previous);
  }
});

test("saves config atomically and refuses corrupt config", () => {
  const { root, previous } = freshEnv();
  try {
    saveConfig({
      apiKey: "sk-test-key",
      apiBase: "http://127.0.0.1:1234",
      quickMode: { quality: "2K", ratio: "portrait", count: 1 },
    });
    const config = loadConfig();
    assert.equal(config.apiKey, "sk-test-key");
    assert.equal(config.quickMode.ratio, "portrait");
    assert.match(readFileSync(process.env.SUBKKAI_IMAGE_GEN_CONFIG, "utf8"), /sk-test-key/);

    writeFileSync(process.env.SUBKKAI_IMAGE_GEN_CONFIG, JSON.stringify({ apiKey: 123 }), "utf8");
    assert.throws(() => loadConfig(), (error) => error.code === "INVALID_API_KEY");

    writeFileSync(process.env.SUBKKAI_IMAGE_GEN_CONFIG, "{broken", "utf8");
    assert.throws(() => loadConfig(), (error) => error.code === "CONFIG_INVALID");
  } finally {
    restoreEnv(root, previous);
  }
});

test("reads API keys from stdin without echoing the full secret", () => {
  const { root, previous } = freshEnv();
  const secret = "test-secret-123456";
  try {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--set-key-stdin"], {
      input: secret,
      encoding: "utf8",
      env: { ...process.env },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.match(result.stdout, /test-sec\.\.\.3456/);
    assert.equal(loadConfig().apiKey, secret);
  } finally {
    restoreEnv(root, previous);
  }
});

test("keeps help available when the config file is corrupt", async () => {
  const { root, previous } = freshEnv();
  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    writeFileSync(process.env.SUBKKAI_IMAGE_GEN_CONFIG, "{broken", "utf8");
    await main(["--help"]);
    assert.match(logs.join("\n"), /Subkkai Image Gen|--set-key-stdin/);
  } finally {
    console.log = originalLog;
    restoreEnv(root, previous);
  }
});

test("validates batch prompt types and image file extensions before network calls", async () => {
  const { root, previous } = freshEnv();
  try {
    const batchPath = join(root, "prompts.json");
    writeFileSync(batchPath, JSON.stringify(["valid", 42]), "utf8");
    assert.throws(() => readBatchPrompts(batchPath), (error) => error.code === "INVALID_PROMPT");

    const imagePath = join(root, "image.txt");
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    await assert.rejects(
      createEditTask({
        apiBase: "http://127.0.0.1:1",
        apiKey: "sk-test-key",
        imagePath,
        prompt: "edit it",
        size: "1024x1024",
      }),
      (error) => error.code === "INVALID_IMAGE",
    );
  } finally {
    restoreEnv(root, previous);
  }
});

test("retries transient GET responses and reports timeouts", async () => {
  const { root, previous } = freshEnv();
  let retryAttempts = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.url === "/retry") {
      retryAttempts += 1;
      if (retryAttempts < 3) return json(response, 503, { message: "busy" });
      return json(response, 200, { ok: true });
    }
    if (request.url === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { message: "not found" });
  });
  try {
    const result = await requestJson(`${base}/retry`, {}, { retries: 2, retryable: true });
    assert.deepEqual(result, { ok: true });
    assert.equal(retryAttempts, 3);
    await assert.rejects(
      requestJson(`${base}/slow`, {}, { timeoutMs: 20 }),
      (error) => error.code === "NETWORK_TIMEOUT",
    );
  } finally {
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("reports meaningful task status changes during long generation", async () => {
  const { root, previous } = freshEnv();
  let polls = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.url === "/v1/image-tasks/task-progress") {
      polls += 1;
      if (polls === 1) return json(response, 200, { status: "queued" });
      if (polls === 2) return json(response, 200, { status: "processing", progress: 42 });
      return json(response, 200, { status: "succeeded", response: { data: [] } });
    }
    return json(response, 404, { message: "not found" });
  });
  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    await pollTask({ apiBase: base, apiKey: "sk-test-key", taskId: "task-progress" });
    assert.equal(polls, 3);
    assert.match(logs.join("\n"), /⏳ 排队中/);
    assert.match(logs.join("\n"), /⏳ 生成中 · 42%/);
  } finally {
    console.log = originalLog;
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("refreshes compact progress once per minute without noisy polling", () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    let report = reportTaskProgress("processing", { progress: 42 }, 0, null, 0);
    report = reportTaskProgress("processing", { progress: 50 }, 0, report, 30_000);
    assert.equal(logs.length, 0);
    report = reportTaskProgress("processing", { progress: 55 }, 0, report, 60_000);
    reportTaskProgress("processing", { progress: 80 }, 0, report, 61_000);
    assert.deepEqual(logs, ["⏳ 生成中 · 55% · 1m"]);
  } finally {
    console.log = originalLog;
  }
});

test("avoids a duplicate zero-second generation status", () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    let report = reportTaskProgress("processing", {}, 0, null, 0);
    assert.equal(logs.length, 0);
    report = reportTaskProgress("processing", {}, 0, report, 59_000);
    assert.equal(logs.length, 0);
    reportTaskProgress("processing", {}, 0, report, 60_000);
    assert.deepEqual(logs, ["⏳ 生成中 · 1m"]);
  } finally {
    console.log = originalLog;
  }
});

test("updates the TTY timer in place without adding lines", () => {
  let currentNow = 0;
  let tick = null;
  let cleared = false;
  const writes = [];
  const timer = { unref() {} };
  const output = {
    isTTY: true,
    write(value) {
      writes.push(value);
      return true;
    },
  };

  const progress = createLiveProgress({
    startedAt: 0,
    activityLabel: "生成中",
    output,
    now: () => currentNow,
    setIntervalFn(callback) {
      tick = callback;
      return timer;
    },
    clearIntervalFn(value) {
      assert.equal(value, timer);
      cleared = true;
    },
  });

  assert.ok(progress);
  assert.equal(writes[0], "\x1b[2K\r⏳ 生成中 · 0s");
  progress.update("processing", { progress: 42 });
  currentNow = 1_000;
  tick();
  assert.equal(writes.at(-1), "\x1b[2K\r⏳ 生成中 · 42% · 1s");
  assert.ok(writes.every((value) => !value.includes("\n")));
  progress.stop();
  assert.equal(cleared, true);
  assert.equal(writes.at(-2), "\x1b[2K\r⏳ 生成中 · 42% · 1s");
  assert.equal(writes.at(-1), "\n");
});

test("updates the Codex non-TTY timer in place and keeps the final progress line", () => {
  let currentNow = 0;
  let tick = null;
  const writes = [];
  const timer = { unref() {} };
  const output = {
    isTTY: false,
    write(value) {
      writes.push(value);
      return true;
    },
  };

  const progress = createLiveProgress({
    startedAt: 0,
    activityLabel: "生成中",
    output,
    allowNonTty: true,
    now: () => currentNow,
    setIntervalFn(callback) {
      tick = callback;
      return timer;
    },
    clearIntervalFn() {},
  });

  assert.ok(progress);
  assert.equal(writes[0], "\r⏳ 生成中 · 0s");
  currentNow = 10_000;
  tick();
  assert.equal(writes.at(-1), "\r⏳ 生成中 · 10s");
  currentNow = 20_000;
  tick();
  assert.equal(writes.at(-1), "\r⏳ 生成中 · 20s");
  progress.stop();
  assert.equal(writes.at(-2), "\r⏳ 生成中 · 20s");
  assert.equal(writes.at(-1), "\n");
  assert.ok(writes.slice(0, -1).every((value) => !value.includes("\n")));
});

test("keeps sparse fallback for non-Codex pipes", () => {
  const output = { isTTY: false, write() {} };
  assert.equal(createLiveProgress({ output, allowNonTty: false }), null);
});

test("runs a complete generation flow against a local mock API", async () => {
  const { root, previous } = freshEnv();
  let createRequests = 0;
  let pollRequests = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/image-tasks/generations") {
      createRequests += 1;
      return json(response, 200, { id: "task-1" });
    }
    if (request.method === "GET" && request.url === "/v1/image-tasks/task-1") {
      pollRequests += 1;
      return json(response, 200, {
        status: "succeeded",
        response: { data: [{ b64_json: PNG_BASE64 }] },
      });
    }
    return json(response, 404, { message: "not found" });
  });

  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    saveConfig({ apiKey: "sk-test-key", apiBase: base });
    const outputDir = join(root, "generated");
    await main(["--prompt", "a red apple", "--output-dir", outputDir]);
    assert.equal(createRequests, 1);
    assert.equal(pollRequests, 1);
    const files = await (await import("node:fs/promises")).readdir(outputDir);
    assert.equal(files.length, 1);
    assert.ok(readFileSync(join(outputDir, files[0])).subarray(0, 8).equals(PNG_SIGNATURE));
    const output = logs.join("\n");
    assert.match(output, /🎨 正在生成 · 2K · 竖版 \(1152x2048\)/);
    assert.match(output, /📝 a red apple/);
    assert.match(output, /✅ 生成完成/);
    assert.match(output, /实际 1x1（请求 1152x2048）/);
    assert.match(output, /📍/);
    assert.match(output, /0\.00MB ｜ 1x1/);
    assert.match(output, /!\[Subkkai result\]\(<.*\/generated\/img_.*\.png>\)/);
    assert.doesNotMatch(output, /任务状态|🆔/);
  } finally {
    console.log = originalLog;
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("checks for updates inside the same generation command", async () => {
  const { root, previous } = freshEnv();
  let manifestRequests = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/manifest.json") {
      manifestRequests += 1;
      return json(response, 200, { name: "subkkai-image-gen", version: "9.9.9" });
    }
    if (request.method === "POST" && request.url === "/v1/image-tasks/generations") {
      return json(response, 200, { id: "task-with-update" });
    }
    if (request.method === "GET" && request.url === "/v1/image-tasks/task-with-update") {
      return json(response, 200, {
        status: "succeeded",
        response: { data: [{ b64_json: PNG_BASE64 }] },
      });
    }
    return json(response, 404, { message: "not found" });
  });

  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    delete process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK;
    process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL = `${base}/manifest.json`;
    process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE = join(root, "update-cache.json");
    saveConfig({ apiKey: "sk-test-key", apiBase: base });

    await main(["--prompt", "one-command update check", "--output-dir", join(root, "generated")]);

    assert.equal(manifestRequests, 1);
    assert.match(logs.join("\n"), /Subkkai Image Gen 有新版本/);
    assert.match(logs.join("\n"), /✅ 生成完成/);
  } finally {
    console.log = originalLog;
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("edits the latest output image in one CLI action", async () => {
  const { root, previous } = freshEnv();
  let uploadedBody = "";
  const { server, base } = await startServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/image-tasks/edits") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploadedBody = Buffer.concat(chunks).toString("latin1");
      return json(response, 200, { id: "edit-task-1" });
    }
    if (request.method === "GET" && request.url === "/v1/image-tasks/edit-task-1") {
      return json(response, 200, {
        status: "succeeded",
        response: { data: [{ b64_json: PNG_BASE64 }] },
      });
    }
    return json(response, 404, { message: "not found" });
  });

  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  try {
    saveConfig({ apiKey: "sk-test-key", apiBase: base });
    const outputDir = join(root, "edits");
    mkdirSync(outputDir, { recursive: true });
    const oldPath = join(outputDir, "old.png");
    const latestPath = join(outputDir, "latest.png");
    writeFileSync(oldPath, Buffer.from(PNG_BASE64, "base64"));
    writeFileSync(latestPath, Buffer.from(PNG_BASE64, "base64"));
    utimesSync(oldPath, new Date(1_000), new Date(1_000));
    utimesSync(latestPath, new Date(2_000), new Date(2_000));

    await main([
      "--edit",
      "--latest-image",
      "--prompt",
      "change the background",
      "--output-dir",
      outputDir,
      "--verbose",
    ]);

    assert.match(uploadedBody, /filename="latest\.png"/);
    assert.doesNotMatch(uploadedBody, /filename="old\.png"/);
    assert.match(logs.join("\n"), /🖼️ latest\.png/);
    assert.match(logs.join("\n"), /✅ 编辑完成/);
    assert.match(logs.join("\n"), /实际 1x1（请求 1152x2048）/);
    assert.match(logs.join("\n"), /!\[Subkkai result\]\(<.*\/edits\/edit_.*\.png>\)/);
    const files = await (await import("node:fs/promises")).readdir(outputDir);
    assert.equal(files.filter((file) => file.startsWith("edit_")).length, 1);
  } finally {
    console.log = originalLog;
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("keeps batch outputs ordered without logging full prompts", async () => {
  const { root, previous } = freshEnv();
  let taskNumber = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/image-tasks/generations") {
      taskNumber += 1;
      return json(response, 200, { id: `task-${taskNumber}` });
    }
    if (request.method === "GET" && request.url.startsWith("/v1/image-tasks/task-")) {
      return json(response, 200, {
        status: "succeeded",
        response: { data: [{ b64_json: PNG_BASE64 }] },
      });
    }
    return json(response, 404, { message: "not found" });
  });
  const originalLog = console.log;
  const logs = [];
  console.log = (...values) => logs.push(values.join(" "));
  const previousExitCode = process.exitCode;
  try {
    saveConfig({ apiKey: "sk-test-key", apiBase: base });
    const outputDir = join(root, "batch");
    await main([
      "--batch-inline",
      "first private prompt",
      "second private prompt",
      "--concurrency",
      "2",
      "--output-dir",
      outputDir,
    ]);
    const files = await (await import("node:fs/promises")).readdir(outputDir);
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.startsWith("img_01_")));
    assert.ok(files.some((file) => file.startsWith("img_02_")));
    assert.doesNotMatch(logs.join("\n"), /first private prompt|second private prompt/);
  } finally {
    process.exitCode = previousExitCode;
    console.log = originalLog;
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("retries image downloads and blocks unsafe redirect targets", async () => {
  const { root, previous } = freshEnv();
  let imageAttempts = 0;
  const { server, base } = await startServer(async (request, response) => {
    if (request.url === "/image") {
      imageAttempts += 1;
      if (imageAttempts < 3) return json(response, 503, { message: "busy" });
      const buffer = Buffer.from(PNG_BASE64, "base64");
      response.statusCode = 200;
      response.setHeader("content-type", "image/png");
      response.end(buffer);
      return;
    }
    if (request.url === "/unsafe-redirect") {
      response.statusCode = 302;
      response.setHeader("location", "http://example.com/image.png");
      response.end();
      return;
    }
    return json(response, 404, { message: "not found" });
  });
  try {
    const outputDir = join(root, "downloads");
    mkdirSync(outputDir, { recursive: true });
    const saved = await saveImageItem({ url: `${base}/image` }, outputDir, "download");
    assert.equal(imageAttempts, 3);
    assert.ok(existsSync(saved.path));
    await assert.rejects(
      saveImageItem({ url: `${base}/unsafe-redirect` }, outputDir, "download"),
      (error) => error.code === "INSECURE_IMAGE_URL",
    );
  } finally {
    await stopServer(server);
    restoreEnv(root, previous);
  }
});

test("sanitizes credentials from diagnostic text", () => {
  const result = sanitizeText("Bearer sk-secret and ?token=abc123", ["sk-secret"]);
  assert.doesNotMatch(result, /sk-secret|abc123/);
  assert.match(result, /REDACTED/);
});

test("AppError exposes stable machine-readable codes", () => {
  const error = new AppError("TEST_CODE", "test");
  assert.equal(error.code, "TEST_CODE");
  assert.equal(error.message, "test");
});

test("adds actionable hints to user-facing errors", () => {
  const timeout = friendlyErrorMessage(new AppError("TASK_TIMEOUT", "task timed out"));
  assert.match(timeout, /仍在运行|查询/);
  const unsafe = friendlyErrorMessage(new AppError("TASK_FAILED", "prompt_unsafe"));
  assert.match(unsafe, /安全策略|改写/);
});

});
