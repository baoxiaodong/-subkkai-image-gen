import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  main,
  normalizeUpdateUrl,
  parseVersion,
} from "../plugins/subkkai-image-gen/scripts/check-update.mjs";

async function startServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(error.message);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  server.close();
  await once(server, "close");
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

describe("Subkkai update checker", { concurrency: false }, () => {
  test("compares semantic versions and accepts the local test URL", () => {
    assert.equal(parseVersion("v0.1.1").value, "0.1.1");
    assert.equal(compareVersions("0.1.2", "0.1.1"), 1);
    assert.equal(compareVersions("0.1.1", "0.1.1"), 0);
    assert.equal(compareVersions("0.1.1-beta.2", "0.1.1-beta.10"), -1);
    assert.equal(compareVersions("0.1.1", "0.1.1-rc.1"), 1);
    assert.equal(normalizeUpdateUrl("http://127.0.0.1:1234/manifest.json"), "http://127.0.0.1:1234/manifest.json");
    assert.throws(() => normalizeUpdateUrl("http://example.com/manifest.json"));
  });

  test("notifies once, then uses the cache during the interval", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-update-test-"));
    const cachePath = join(root, "update-cache.json");
    let requests = 0;
    const { server, base } = await startServer((request, response) => {
      requests += 1;
      assert.equal(request.url, "/manifest.json");
      return sendJson(response, 200, { name: "subkkai-image-gen", version: "0.2.0" });
    });
    const firstTime = Date.parse("2026-07-27T10:00:00.000Z");
    try {
      const first = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath,
        now: firstTime,
        force: true,
        checkIntervalMs: 86_400_000,
        noticeIntervalMs: 86_400_000,
      });
      assert.equal(first.updateAvailable, true);
      assert.equal(first.shouldNotify, true);
      assert.match(first.notice, /v0\.1\.1.*v0\.2\.0/s);
      assert.equal(requests, 1);

      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(cached.latestVersion, "0.2.0");
      assert.equal(cached.lastNotifiedVersion, "0.2.0");

      const second = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath,
        now: firstTime + 60_000,
        checkIntervalMs: 86_400_000,
        noticeIntervalMs: 86_400_000,
      });
      assert.equal(second.source, "cache");
      assert.equal(second.shouldNotify, false);
      assert.equal(requests, 1);
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("continues silently when the endpoint is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-update-test-"));
    const cachePath = join(root, "update-cache.json");
    let requests = 0;
    const { server, base } = await startServer((request, response) => {
      requests += 1;
      return sendJson(response, 503, { message: "busy" });
    });
    const now = Date.parse("2026-07-27T10:00:00.000Z");
    try {
      const first = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath,
        now,
        force: true,
        timeoutMs: 200,
      });
      assert.equal(first.status, "unavailable");
      assert.equal(first.shouldNotify, false);
      assert.equal(requests, 1);

      const second = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath,
        now: now + 1_000,
        checkIntervalMs: 86_400_000,
      });
      assert.equal(second.shouldNotify, false);
      assert.equal(requests, 1);
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers from a corrupt cache and still notifies when cache writes fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-update-test-"));
    const corruptCachePath = join(root, "corrupt-cache.json");
    const unwritableCachePath = join(root, "cache-directory");
    writeFileSync(corruptCachePath, "{broken", "utf8");
    mkdirSync(unwritableCachePath);
    const { server, base } = await startServer((request, response) =>
      sendJson(response, 200, { name: "subkkai-image-gen", version: "0.2.0" }),
    );
    try {
      const recovered = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath: corruptCachePath,
        now: Date.parse("2026-07-27T10:00:00.000Z"),
      });
      assert.equal(recovered.shouldNotify, true);

      const noWrite = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath: unwritableCachePath,
        now: Date.parse("2026-07-27T10:01:00.000Z"),
        force: true,
      });
      assert.equal(noWrite.shouldNotify, true);
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not notify when the installed version is current", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-update-test-"));
    const cachePath = join(root, "update-cache.json");
    const { server, base } = await startServer((request, response) =>
      sendJson(response, 200, { name: "subkkai-image-gen", version: "0.1.1" }),
    );
    try {
      const result = await checkForUpdate({
        currentVersion: "0.1.1",
        updateUrl: `${base}/manifest.json`,
        cachePath,
        force: true,
      });
      assert.equal(result.updateAvailable, false);
      assert.equal(result.shouldNotify, false);
      assert.equal(formatUpdateNotice({ currentVersion: "0.1.1", latestVersion: "0.2.0" }), "🆕 **Subkkai Image Gen 有新版本**\n\n当前 v0.1.1 → 最新 v0.2.0\n\n回复「更新插件」即可在 Codex 中更新；当前生图会照常继续。");
    } finally {
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI mode prints a Codex-ready notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "subkkai-update-test-"));
    const previous = {
      url: process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL,
      cache: process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE,
      timeout: process.env.SUBKKAI_IMAGE_GEN_UPDATE_TIMEOUT_MS,
      disabled: process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK,
    };
    const { server, base } = await startServer((request, response) =>
      sendJson(response, 200, { name: "subkkai-image-gen", version: "0.2.0" }),
    );
    const originalLog = console.log;
    const logs = [];
    console.log = (...values) => logs.push(values.join(" "));
    try {
      process.env.SUBKKAI_IMAGE_GEN_UPDATE_URL = `${base}/manifest.json`;
      process.env.SUBKKAI_IMAGE_GEN_UPDATE_CACHE = join(root, "update-cache.json");
      process.env.SUBKKAI_IMAGE_GEN_UPDATE_TIMEOUT_MS = "200";
      delete process.env.SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK;
      await main(["--force"]);
      assert.match(logs.join("\n"), /Subkkai Image Gen 有新版本/);
      assert.match(logs.join("\n"), /更新插件/);
    } finally {
      console.log = originalLog;
      for (const [key, value] of Object.entries({
        SUBKKAI_IMAGE_GEN_UPDATE_URL: previous.url,
        SUBKKAI_IMAGE_GEN_UPDATE_CACHE: previous.cache,
        SUBKKAI_IMAGE_GEN_UPDATE_TIMEOUT_MS: previous.timeout,
        SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK: previous.disabled,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await stopServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
