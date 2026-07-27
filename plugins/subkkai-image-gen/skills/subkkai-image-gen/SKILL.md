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
the image request. If it returns `MISSING_API_KEY`, use First-time setup. If it
returns `NO_IMAGE_AVAILABLE`, ask the user to attach an image or provide a path.

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

When a direct command reports `MISSING_API_KEY`, ask for the user's key once.
Never repeat it in chat or put it in a command argument. Pass it through stdin:

```bash
node "$SCRIPT" --set-key-stdin
```

After the key is saved, immediately retry the original generation/edit command.
The default quick settings are 2K, portrait, one image; do not force a separate
settings wizard unless the user asks to configure defaults.

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
