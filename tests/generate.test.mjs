import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  apiUrl,
  createEditTask,
  createGenerationTask,
  extractImageItems,
  parseArgs,
  pollTask,
  requestJson,
  resolveModeParams,
  runEdit,
  runGeneration,
  taskPollUrl,
} from "../plugins/subkkai-image-gen/scripts/generate.mjs";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function startServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: error.message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("Subkkai Image Gen optimized task API", { concurrency: false }, () => {
  test("builds v1 API URLs without duplicating /v1", () => {
    assert.equal(
      apiUrl("https://subkkai.com", "image-tasks/generations"),
      "https://subkkai.com/v1/image-tasks/generations",
    );
    assert.equal(
      apiUrl("https://subkkai.com/v1/", "/image-tasks/edits"),
      "https://subkkai.com/v1/image-tasks/edits",
    );
    assert.equal(
      taskPollUrl(
        "https://subkkai.com",
        "safe-task",
        "https://attacker.example/steal-key",
      ),
      "https://subkkai.com/v1/image-tasks/safe-task",
    );
  });

  test("submits the verified minimal generation payload to the task wrapper", async () => {
    let captured;
    const { server, base } = await startServer(async (request, response) => {
      captured = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse((await readBody(request)).toString("utf8")),
      };
      json(response, 202, {
        id: "task-1",
        poll_url: "/v1/image-tasks/task-1",
        status: "pending",
      });
    });

    try {
      const task = await createGenerationTask({
        apiBase: base,
        apiKey: "sk-test-key",
        prompt: "a red apple",
        size: "1024x1024",
      });
      assert.equal(captured.method, "POST");
      assert.equal(captured.url, "/v1/image-tasks/generations");
      assert.equal(captured.authorization, "Bearer sk-test-key");
      assert.deepEqual(captured.body, {
        model: "gpt-image-2",
        prompt: "a red apple",
        n: 1,
        size: "1024x1024",
        stream: false,
      });
      assert.equal(task.taskId, "task-1");
      assert.equal(task.pollUrl, `${base}/v1/image-tasks/task-1`);
    } finally {
      await stopServer(server);
    }
  });

  test("submits multipart edit tasks with image[] and no unnecessary quality fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-task-edit-test-"));
    const imagePath = join(root, "source.png");
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    let captured;
    const { server, base } = await startServer(async (request, response) => {
      captured = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: (await readBody(request)).toString("latin1"),
      };
      json(response, 202, {
        id: "edit-task-1",
        poll_url: "/v1/image-tasks/edit-task-1",
        status: "pending",
      });
    });

    try {
      const task = await createEditTask({
        apiBase: base,
        apiKey: "sk-test-key",
        imagePath,
        prompt: "make it blue",
        size: "1024x1024",
      });
      assert.equal(captured.method, "POST");
      assert.equal(captured.url, "/v1/image-tasks/edits");
      assert.equal(captured.authorization, "Bearer sk-test-key");
      assert.match(captured.contentType, /^multipart\/form-data; boundary=/);
      assert.match(captured.body, /name="model"\r\n\r\ngpt-image-2/);
      assert.match(captured.body, /name="prompt"\r\n\r\nmake it blue/);
      assert.match(captured.body, /name="n"\r\n\r\n1/);
      assert.match(captured.body, /name="size"\r\n\r\n1024x1024/);
      assert.match(captured.body, /name="image\[\]"; filename="source.png"/);
      assert.doesNotMatch(captured.body, /name="quality"/);
      assert.doesNotMatch(captured.body, /name="moderation"/);
      assert.doesNotMatch(captured.body, /name="output_format"/);
      assert.equal(task.taskId, "edit-task-1");
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("polls at a short fixed cadence instead of exponential multi-second backoff", async () => {
    let polls = 0;
    const { server, base } = await startServer(async (request, response) => {
      assert.equal(request.url, "/v1/image-tasks/task-fast");
      polls += 1;
      if (polls === 1) {
        json(response, 200, { status: "running" });
        return;
      }
      json(response, 200, {
        status: "succeeded",
        response: { data: [{ b64_json: PNG_BASE64 }] },
      });
    });

    const startedAt = Date.now();
    try {
      const task = await pollTask({
        apiBase: base,
        apiKey: "sk-test-key",
        taskId: "task-fast",
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(polls, 2);
      assert.equal(task.status, "succeeded");
      assert.ok(elapsed >= 200, `expected a short poll delay, got ${elapsed}ms`);
      assert.ok(elapsed < 2_000, `polling regressed to a long delay: ${elapsed}ms`);
    } finally {
      await stopServer(server);
    }
  });

  test("runs generation and edit flows only through task endpoints and saves results", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-task-flow-test-"));
    const outputDir = join(root, "output");
    mkdirSync(outputDir, { recursive: true });
    const imagePath = join(root, "source.png");
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
    const requestedUrls = [];
    const { server, base } = await startServer(async (request, response) => {
      requestedUrls.push(request.url);
      if (request.method === "POST" && request.url === "/v1/image-tasks/generations") {
        await readBody(request);
        json(response, 202, { id: "gen-task", poll_url: "/v1/image-tasks/gen-task" });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/image-tasks/edits") {
        await readBody(request);
        json(response, 202, { id: "edit-task", poll_url: "/v1/image-tasks/edit-task" });
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/v1/image-tasks/")) {
        json(response, 200, {
          status: "succeeded",
          response: { data: [{ b64_json: PNG_BASE64 }] },
        });
        return;
      }
      json(response, 404, { message: "not found" });
    });

    try {
      const generated = await runGeneration({
        apiBase: base,
        apiKey: "sk-test-key",
        prompt: "a cup",
        size: "1024x1024",
        outputDir,
      });
      const edited = await runEdit({
        apiBase: base,
        apiKey: "sk-test-key",
        imagePath,
        prompt: "make it green",
        size: "1024x1024",
        outputDir,
      });

      assert.deepEqual(requestedUrls, [
        "/v1/image-tasks/generations",
        "/v1/image-tasks/gen-task",
        "/v1/image-tasks/edits",
        "/v1/image-tasks/edit-task",
      ]);
      assert.equal(generated.taskId, "gen-task");
      assert.equal(edited.taskId, "edit-task");
      assert.deepEqual(readFileSync(generated.saved[0].path), Buffer.from(PNG_BASE64, "base64"));
      assert.deepEqual(readFileSync(edited.saved[0].path), Buffer.from(PNG_BASE64, "base64"));
      assert.equal(
        requestedUrls.some((url) => url.startsWith("/v1/images/")),
        false,
      );
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retries skipped_mainline once because the upstream reports no main generation ran", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-skipped-mainline-test-"));
    const outputDir = join(root, "output");
    mkdirSync(outputDir, { recursive: true });
    let submissions = 0;
    const { server, base } = await startServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/v1/image-tasks/generations") {
        await readBody(request);
        submissions += 1;
        json(response, 202, {
          id: `task-${submissions}`,
          poll_url: `/v1/image-tasks/task-${submissions}`,
        });
        return;
      }
      if (request.url === "/v1/image-tasks/task-1") {
        json(response, 200, {
          status: "failed",
          error: { skipped_mainline: true },
        });
        return;
      }
      if (request.url === "/v1/image-tasks/task-2") {
        json(response, 200, {
          status: "succeeded",
          response: { data: [{ b64_json: PNG_BASE64 }] },
        });
        return;
      }
      json(response, 404, { message: "not found" });
    });

    const originalLog = console.log;
    const logs = [];
    console.log = (...values) => logs.push(values.join(" "));
    try {
      const result = await runGeneration({
        apiBase: base,
        apiKey: "sk-test-key",
        prompt: "a retry test",
        size: "1024x1024",
        outputDir,
      });
      assert.equal(submissions, 2);
      assert.equal(result.taskId, "task-2");
      assert.match(logs.join("\n"), /安全重试一次/);
    } finally {
      console.log = originalLog;
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports task response variants and retries transient polling requests", async () => {
    assert.deepEqual(
      extractImageItems({ response: { data: [{ url: "https://example.test/a.png" }] } }),
      [{ url: "https://example.test/a.png" }],
    );

    let attempts = 0;
    const { server, base } = await startServer(async (_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        json(response, 503, { message: "busy" });
        return;
      }
      json(response, 200, { ok: true });
    });
    try {
      const value = await requestJson(`${base}/retry`, {}, { retries: 2 });
      assert.deepEqual(value, { ok: true });
      assert.equal(attempts, 3);
    } finally {
      await stopServer(server);
    }
  });

  test("keeps CLI argument and size selection behavior stable", () => {
    const parsed = parseArgs([
      "--prompt",
      "a cat",
      "--quality",
      "1K",
      "--ratio",
      "square",
      "--count",
      "2",
    ]);
    assert.deepEqual(parsed.prompts, ["a cat"]);
    assert.equal(parsed.flags.count, 2);
    assert.deepEqual(
      resolveModeParams(parsed.flags, null),
      { quality: "1K", ratio: "square", size: "1024x1024" },
    );
  });
});
