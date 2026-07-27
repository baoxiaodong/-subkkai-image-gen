---
name: "subkkai-image-gen"
description: "Generate or edit images using the Subkkai Image Gen plugin. Trigger when the user wants to create, draw, generate, or edit images through Subkkai gpt-image-2 task-mode APIs, wants batch image generation, needs AI-generated images saved to disk, refers to the previous/latest generated image, or asks to check or update this plugin. Do not use for SVG/vector work or unrelated image tools."
---

# Subkkai Image Gen

Use the bundled CLI for deterministic generation and editing.

## Resolve scripts

Resolve `../../scripts/generate.mjs` and `../../scripts/check-update.mjs`
relative to this `SKILL.md`, convert them to absolute paths, and call them
`SCRIPT` and `UPDATE_SCRIPT`. Never assume a fixed installation directory.

## Fast path — highest priority

For a clear single-image generation or edit request, send one compact status
message and immediately run exactly one image command. Do not first run
`--get-config`, the separate update checker, directory listings, image searches,
or visual inspection. Do not spend time preparing a PTY; use the shell's normal
execution mode. The CLI loads saved config, performs the cached update check,
and keeps the compact visible status sequence itself, including Codex non-TTY
command cards.

Generate:

```bash
node "$SCRIPT" --prompt "<prompt>" [--quality Q] [--ratio R] [--count N]
```

Edit an attached image or an explicit readable path:

```bash
node "$SCRIPT" --edit --image "<image_path>" --prompt "<edit instruction>" [--quality Q] [--ratio R]
```

Edit “上一张 / 刚才那张 / 最近生成的图片” when no explicit path is available:

```bash
node "$SCRIPT" --edit --latest-image --prompt "<edit instruction>" [--quality Q] [--ratio R]
```

Only pass quality, ratio, or count when the user explicitly overrides saved
defaults. Never run a second command merely to rediscover values the CLI can
load itself.

If the command succeeds, the CLI prints a final Markdown image line such as
`![Subkkai result](<C:/.../image.png>)`. Copy that line verbatim into the final
answer and end the task. Do not call another tool, copy/move the file, Base64
encode it, inspect it, explain the execution, or ask a follow-up question.

If the CLI prints an update notice, show it once without delaying or cancelling
the image request. If it returns `MISSING_API_KEY` or `MISSING_QUICK_MODE`, use
First-time setup. If it returns `NO_IMAGE_AVAILABLE`, ask the user to attach an
image or provide a path.

## Response rules

- Start with `🎨 正在生成。` or `✏️ 正在编辑。` and then execute immediately.
- Preserve the CLI's compact command-card sequence: effective quality/ratio,
  short prompt preview, one in-place `⏳ 生成中 · 10s` timer line, completion
  time, and the final Markdown image. Do not suppress these user-visible lines.
- Keep commands, task IDs, polling internals, and extra explanations out of
  chat; the command card already contains the useful status.
- Do not require PTY/TTY. The CLI refreshes one timer line in TTY terminals and
  Codex command cards, including Codex non-TTY execution. Log-only non-Codex
  pipes retain a sparse 60-second fallback.
- Do not inspect, critique, or describe the result unless the user explicitly
  asks for verification or review.
- Do not ask for confirmation for one image. Confirm before batch generation.
- Never reveal a full API key or paste full upstream responses.

## First-time setup

First installation uses the complete four-step setup flow. It appears only when
a direct command returns `MISSING_API_KEY` or `MISSING_QUICK_MODE`; users who
already completed it still keep the normal one-command fast path.

### Step 1 — API Key

When the command returns `MISSING_API_KEY`, show this exactly:

> 👋 欢迎使用 **Subkkai Image Gen**！首次使用需要快速设置一下
>
> 整个过程只需 30 秒，之后每次 @我 + 描述就能直接出图 ⚡
>
> ---
>
> 🔑 **第一步：请提供你的 API Key**
>
> 把你的 Key 提供给我，我只会把它保存到本地配置，并在回复里显示打码预览；不要把完整 Key 写进命令参数 🔒

When the user provides the key, never repeat it in chat or put it in a command
argument. Pass it through stdin:

```bash
node "$SCRIPT" --set-key-stdin
```

Show the script output as-is, retain the original request, then continue to
Step 2. Do not retry the original image request before the quick mode is saved.

When the command returns `MISSING_QUICK_MODE`, skip Step 1 and start at Step 2;
the user already has a usable Key but has not finished first-time setup.

### Step 2 — Choose quality

Show this exactly, then wait for the choice:

> ⚡ **第二步：设置快速模式** — 以后 @我 + 描述就按这个配置直接出图！
>
> 🎨 选择默认 **分辨率档位**：
>
> | 选项 | 分辨率 | 速度 | 适合场景 |
> |------|--------|------|----------|
> | **1K** 🚀 | ~1百万像素 | 最快 | 草稿、缩略图、测试 |
> | **2K** ✨ _(推荐)_ | ~4百万像素 | 平衡 | 日常使用、微信出图 |
> | **4K** 💎 | ~8百万像素 | 上游繁忙时可能超时 | 高清大图、细节图 |

Map the choice to `1K`, `2K`, or `4K`. If the user says “推荐” or “默认”, use
`2K`, then continue to Step 3.

### Step 3 — Choose ratio

Show this exactly, then wait for the choice:

> 📐 选择默认 **比例**：
>
> | 选项 | 比例 | 1K | 2K | 4K |
> |------|------|-----|-----|-----|
> | ⬜ **正方形** | 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
> | 🖼️ **横版** | 16:9 / 3:2 | 1536×1024 | 2048×1152 | 3840×2160 |
> | 📱 **竖版** _(人像推荐)_ | 9:16 / 2:3 | 1024×1536 | 1152×2048 | 2160×3840 |

Map the choice to `square`, `landscape`, or `portrait`. If the user says
“推荐” or “默认”, use `portrait`, then continue to Step 4.

### Step 4 — Choose count

Show this exactly, then wait for the choice:

> 🔢 每次默认生成 **几张**？（1~4 张）
>
> 多张 = 同一描述生成不同变体，选 1 张最快 ⚡

Accept only `1` through `4`. If the user says “推荐” or “默认”, use `1`.

### Save and resume

After all three choices are collected, run:

```bash
node "$SCRIPT" --set-quick-mode --quality <Q> --ratio <R> --count <N>
```

Show the script output as-is. If the original request contained a single-image
generation or edit, immediately resume that original request using the saved
settings without making the user repeat it. If it was a batch request, resume
the normal batch confirmation from the original request instead.

## Settings

Use `--get-config` only when the user explicitly asks to view or change settings:

```bash
node "$SCRIPT" --get-config
node "$SCRIPT" --set-quick-mode --quality <1K|2K|4K> --ratio <square|landscape|portrait> --count <1-4>
node "$SCRIPT" --set-batch-mode --quality <1K|2K|4K> --ratio <square|landscape|portrait> --concurrency <1-10>
node "$SCRIPT" --set-api-base <HTTPS_URL>
```

Use `--set-key-stdin` for key replacement. Remote API bases must use HTTPS;
HTTP is allowed only for localhost development or an explicit insecure opt-in.

## Batch generation

Batch means multiple different prompts. Collect the prompts and confirm the
prompt count, quality, ratio, concurrency, and output directory before running:

```bash
node "$SCRIPT" --batch-inline "<p1>" "<p2>" ["<p3>" ...] [--quality Q] [--ratio R] [--concurrency N]
node "$SCRIPT" --batch "<prompts.json>" [--quality Q] [--ratio R] [--concurrency N]
```

Maximums: 20 prompts and concurrency 10. Do not print every full prompt in
progress logs.

## Update plugin

Only update after the user explicitly asks. Run sequentially:

```bash
codex plugin marketplace upgrade subkkai
codex plugin add subkkai-image-gen@subkkai
```

If marketplace refresh fails, stop without removing the installed plugin. After
success, report the installed version and tell the user to start a new Codex
task so the newly loaded skill is used.

For a manual version check only, run:

```bash
node "$UPDATE_SCRIPT" --force
```

## Error handling

- `prompt_unsafe`: explain that upstream moderation rejected the prompt and
  suggest a safer rewrite.
- `bad_size`: report the supported 1K/2K/4K presets.
- `No available compatible accounts`: wait about 30 seconds and retry once only
  when no other paid request has started.
- Task timeout: explain that the remote task may still be running; do not create
  a duplicate paid task without confirmation.
- Never blindly retry task-creation POST requests because they may create a
  second paid task.

## Security and runtime

- Requires Node.js 18.17 or newer; Node 20+ is recommended.
- Prefer `SUBKKAI_IMAGE_GEN_API_KEY` for ephemeral or CI use.
- Prompts and edit images are sent to the configured Subkkai API base.
- The update check sends no prompt, image, or API key and caches only version
  metadata for 24 hours.
