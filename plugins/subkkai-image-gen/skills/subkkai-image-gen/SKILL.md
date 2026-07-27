---
name: "subkkai-image-gen"
description: "Generate or edit images using the Subkkai Image Gen plugin. Trigger when the user wants to create, draw, generate, or edit images through Subkkai gpt-image-2 task-mode APIs, wants batch image generation, needs AI-generated images saved to disk, wants to modify an existing image, or asks to check or update this plugin. Do not use for SVG/vector work or unrelated image tools."
---

# Subkkai Image Gen

Use the Subkkai task-mode image APIs through the bundled `scripts/generate.mjs`.

## Script location

Resolve `../../scripts/generate.mjs` and `../../scripts/check-update.mjs`
relative to the directory containing this `SKILL.md`, convert both to absolute
paths, and refer to them as `SCRIPT` and `UPDATE_SCRIPT` respectively.
Never assume the plugin lives under `$HOME/plugins` or that the shell's current
directory is the plugin root; this keeps marketplace installations portable on
Windows, macOS, and Linux.

## Output rules

1. Show script stdout to the user as the primary result.
2. Do not reveal full API keys. Only key previews are safe.
3. After successful generation or editing, display the saved image path and embed the image when the client supports local image rendering.
4. Do not ask for confirmation in quick single-image generation or editing. Batch generation requires confirmation.
5. When this file marks a message with `Original output`, show that quoted message to the user exactly; do not rewrite, summarize, or remove emoji/tables.
6. If the user pastes an API key, never repeat the full key in chat. Pass it
   through stdin to `--set-key-stdin`; never place the full key in a command
   argument, log line, or prompt. Show only the script's masked preview.
7. If the update-check script prints a notice, show that notice exactly once at
   the top of the response, then continue the user's image request without
   asking for confirmation or delaying generation.
8. Never install an update merely because one is available. Update only after
   the user explicitly asks to update the plugin.

## Entry logic

Every time this skill is triggered, first run:

```bash
node "$UPDATE_SCRIPT"
```

The checker sends no prompt, image, or API key. It checks at most once every 24
hours, caches only version metadata, and prints nothing when no update is
available. If it prints a notice, show it exactly before the normal response.
If it exits with an error or prints nothing, continue silently; an update check
must never block generation or editing.

If the user explicitly asks to update, use Branch U and stop. Otherwise run:

```bash
node "$SCRIPT" --get-config
```

The output is JSON:

```json
{
  "hasKey": true,
  "keyPreview": "sk-xxxx...abcd",
  "quickMode": { "quality": "2K", "ratio": "portrait", "count": 1 },
  "batchMode": { "quality": "2K", "ratio": "portrait", "concurrency": 3 },
  "apiBase": "https://subkkai.com"
}
```

Pick the first matching branch:

| # | Condition | Branch |
|---|-----------|--------|
| 1 | User explicitly asks to update this plugin | U: Update plugin |
| 2 | `hasKey` is false | A: First-time setup |
| 3 | `quickMode` is null | A2: Quick mode setup |
| 4 | User wants settings/config changes | C: Modify config |
| 5 | User wants batch generation | D: Batch mode |
| 6 | User wants to edit an existing image | F: Edit image |
| 7 | User gave a prompt | B: Quick mode |
| 8 | No clear prompt | E: Help |

## Branch U: Update plugin

Enter this branch only when the user clearly asks to update, upgrade, or install
the newly announced version. Run these commands sequentially:

```bash
codex plugin marketplace upgrade subkkai
codex plugin add subkkai-image-gen@subkkai
```

If marketplace refresh fails, report the error and stop; do not remove the
installed plugin. If installation succeeds, tell the user to start a new Codex
thread so the newly installed skill is loaded. Show command output without
revealing unrelated local paths or configuration values.

## Branch A: First-time setup

Original output:

> 👋 欢迎使用 **Subkkai Image Gen**！首次使用需要快速设置一下
>
> 整个过程只需 30 秒，之后每次 @我 + 描述就能直接出图 ⚡
>
> ---
>
> 🔑 **第一步：请提供你的 API Key**
>
> 把你的 Key 提供给我，我只会把它保存到本地配置，并在回复里显示打码预览；不要把完整 Key 写进命令参数 🔒

When the user provides the key, do not echo it. Run:

```bash
node "$SCRIPT" --set-key-stdin
```

Provide the key through the command's stdin, show the script output as-is,
then continue to Branch A2. Never echo the key into chat.

## Branch A2: Quick mode setup

Use this branch after saving the key, or when the key exists but quick mode has not been configured.

### W2: Choose quality

Original output:

> ⚡ **第二步：设置快速模式** — 以后 @我 + 描述就按这个配置直接出图！
>
> 🎨 选择默认 **分辨率档位**：
>
> | 选项 | 分辨率 | 速度 | 适合场景 |
> |------|--------|------|----------|
> | **1K** 🚀 | ~1百万像素 | 最快 | 草稿、缩略图、测试 |
> | **2K** ✨ _(推荐)_ | ~4百万像素 | 平衡 | 日常使用、微信出图 |
> | **4K** 💎 | ~8百万像素 | 较慢 | 高清大图、细节图 |

The CLI flag remains named `--quality` for backward compatibility, but 1K/2K/4K
primarily selects output resolution. Wait for the user to choose. Default to
`2K` if the user says recommended/default.

### W3: Choose ratio

Original output:

> 📐 选择默认 **比例**：
>
> | 选项 | 比例 | 1K | 2K | 4K |
> |------|------|-----|-----|-----|
> | ⬜ **正方形** | 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
> | 🖼️ **横版** | 16:9 / 3:2 | 1536×1024 | 2048×1152 | 3840×2160 |
> | 📱 **竖版** _(人像推荐)_ | 9:16 / 2:3 | 1024×1536 | 1152×2048 | 2160×3840 |

Map choices to `square`, `landscape`, or `portrait`.

### W4: Choose count

Original output:

> 🔢 每次默认生成 **几张**？（1~4 张）
>
> 多张 = 同一描述生成不同变体，选 1 张最快 ⚡

Default to `1`.

### W5: Save quick mode

Run:

```bash
node "$SCRIPT" --set-quick-mode --quality <Q> --ratio <R> --count <N>
```

Show the script output as-is.

If the original user message contained a generation prompt, continue to Branch B without making the user repeat it. If the original request was only setup, stop and wait for the next user message.

## Branch B: Quick mode

Extract the image prompt and run:

```bash
node "$SCRIPT" --prompt "<prompt>" [--quality Q] [--ratio R] [--count N]
```

Only pass `--quality`, `--ratio`, or `--count` when the user explicitly requested
them. Otherwise omit these flags and let the script use saved quick mode. The
script creates a Subkkai task, reports meaningful status changes while polling,
saves the final image atomically, and prints the output path. After success,
embed the local image instead of showing only a path.

## Branch C: Modify config

Show current config from `--get-config`, then output this with values filled in:

> ⚙️ **当前配置：**
>
> | 模式 | 画质 | 比例 | 参数 |
> |------|------|------|------|
> | ⚡ 快速模式 | [Q] | [R] | 每次 [N] 张 |
> | 📦 批量模式 | [Q or 未设置] | [R or —] | 并发 [N or —] |
> | 🔑 API Key | [preview] | | |
> | 🌐 API Base | [apiBase] | | |
>
> 要修改哪个？
>
> 1️⃣ ⚡ 快速模式
>
> 2️⃣ 📦 批量模式
>
> 3️⃣ 🔑 API Key
>
> 4️⃣ 🌐 API Base

Then update only the requested part:

```bash
node "$SCRIPT" --set-key-stdin
node "$SCRIPT" --set-quick-mode --quality <Q> --ratio <R> --count <N>
node "$SCRIPT" --set-batch-mode --quality <Q> --ratio <R> --concurrency <N>
node "$SCRIPT" --set-api-base <BASE_URL>
```

## Branch D: Batch mode

Batch mode means multiple different prompts.

If `batchMode` is null, collect:

Original output:

> 📦 **批量模式 — 先快速设置默认参数** ⚡

Ask quality using the same table as W2, ratio using the same table as W3, then output:

> ⚡ 选择 **并行数**（1~10，默认 3）
>
> 数字越大越快，但可能触发 API 限流
>
> | 并行数 | 适合场景 |
> |--------|----------|
> | 1~2 | 稳定优先 🛡️ |
> | 3 _(推荐)_ | 速度与稳定平衡 ⚖️ |
> | 5~10 | 大批量快速出图 🚀 |

Save:

```bash
node "$SCRIPT" --set-batch-mode --quality <Q> --ratio <R> --concurrency <N>
```

Collect prompts from comma-separated text, one prompt per line, or a JSON file. Confirm before execution, then run either:

> 📝 **请提供 prompt 列表：**
>
> 📌 方式一：每行一个 prompt，写完后说「**开始**」
>
> 📌 方式二：提供一个 JSON 文件路径（内容为 prompt 字符串数组）

Before execution, show:

> 📦 **批量生成确认：**
>
> | 项目 | 值 |
> |------|----|
> | 📝 Prompt 数量 | [N] 条 |
> | 🎨 画质 | [Q] |
> | 📐 比例 | [R] ([WxH]) |
> | ⚡ 并发 | [C] |
> | 📁 输出 | ~/Pictures/subkkai-image-gen/ |
>
> ✅ 确认开始？

```bash
node "$SCRIPT" --batch-inline "<p1>" "<p2>" "<p3>"
node "$SCRIPT" --batch <prompts.json>
```

The script numbers batch outputs (`#1`, `#2`, ...) and includes the same index
in generated filenames so users can map each result back to the confirmed
prompt order without exposing every prompt in logs.

## Branch E: Help

Original output:

> 🎨 **Subkkai Image Gen — 使用指南**
>
> ⚡ **生成图片**：@我 + 图片描述（例：一张白底红苹果产品图）
>
> ✏️ **编辑图片**：提供图片路径后说「换背景」「去掉XX」「改成XX风格」
>
> 📦 **批量生成**：跟我说「批量生成」
>
> ⚙️ **修改配置**：跟我说「修改配置」
>
> 📊 **当前快速模式**：[Q] [R] ×[N]

## Branch F: Edit image

Determine the image source:

1. Use a file path provided by the user.
2. Otherwise use the most recent generated image in the conversation, if available.
3. If no image is available, ask the user to provide a path or attach an image.

Run:

```bash
node "$SCRIPT" --edit --image "<image_path>" --prompt "<edit instruction>" [--quality Q] [--ratio R]
```

The script uploads the image through `multipart/form-data` using field `image[]`, creates an edit task, polls for completion, and saves the result.

## Subkkai API contract

Default base URL:

```txt
https://subkkai.com
```

Generation task:

```txt
POST /v1/image-tasks/generations
Content-Type: application/json
Authorization: Bearer <API_KEY>
```

Edit task:

```txt
POST /v1/image-tasks/edits
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data
```

Task polling:

```txt
GET /v1/image-tasks/{task_id}
Authorization: Bearer <API_KEY>
```

Expected successful result shape:

```json
{
  "status": "succeeded",
  "response": {
    "data": [{ "b64_json": "..." }]
  }
}
```

Also support `response.data[].url`.

## Parameter rules

- Model: default `gpt-image-2`.
- `--quality` is a backward-compatible name for the local 1K/2K/4K resolution
  preset; send upstream `quality: "high"` by default.
- Ratio is converted to `size`; do not send `ratio` upstream.
- Explicit user parameters override saved config.
- Saved quick mode and batch mode are independent.
- Maximum quick count: `4`.
- Maximum batch prompts: `20`.
- Maximum concurrency: `10`.

## Size matrix

| Quality | square | landscape | portrait |
|---|---|---|---|
| 1K | 1024x1024 | 1536x1024 | 1024x1536 |
| 2K | 2048x2048 | 2048x1152 | 1152x2048 |
| 4K | 2880x2880 | 3840x2160 | 2160x3840 |

## Runtime and security rules

- Requires Node.js 18.17 or newer (Node 20+ recommended).
- Prefer `SUBKKAI_IMAGE_GEN_API_KEY` for ephemeral or CI use; otherwise use
  the local config created by `--set-key-stdin`.
- Remote API bases must use HTTPS. HTTP is only acceptable for localhost
  development or when the user explicitly passes `--allow-insecure-api-base`.
- The script retries transient polling and download errors, but does not
  blindly retry task-creation POST requests because that could create duplicate
  paid tasks without an upstream idempotency key.
- Do not paste full upstream responses into chat. The script redacts
  credentials, signed URL query strings, and large payloads.

## Error handling

- `prompt_unsafe`: tell the user the prompt was rejected by upstream moderation and suggest a safer rewrite.
- `bad_size`: retry only if a clear closest supported size exists; otherwise report supported sizes.
- `No available compatible accounts`: explain the capacity issue, wait 30
  seconds, and retry the user operation once only when the user has not started
  another batch; do not blindly replay a task-creation request in parallel.
- Task timeout: report timeout and offer retry.
- Missing key: route to Branch A.
