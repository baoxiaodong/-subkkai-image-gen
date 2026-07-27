# Subkkai Image Gen Marketplace

Codex marketplace for the `subkkai-image-gen` plugin. The plugin runs locally
in Codex, calls the configured Subkkai task API, and saves generated images to
the user's computer.

## Requirements

- Codex CLI or Codex app with local shell/file access.
- Node.js 18.17 or newer (Node 20+ recommended).
- A user-owned Subkkai API key. This repository never contains a key.

## Install

```powershell
codex plugin marketplace add https://github.com/baoxiaodong/-subkkai-image-gen.git
codex plugin add subkkai-image-gen@subkkai
```

Restart Codex, then use:

```text
[@subkkai-image-gen](plugin://subkkai-image-gen@subkkai) 我想生成一些图片
```

## Fast response behavior

Normal single-image generation and editing use one CLI command. The skill does
not pre-read config, separately check for updates, scan output folders, or
prepare a PTY. The CLI handles config and the cached update check internally,
shows a short prompt/size preview, and refreshes one live timer line in both TTY
terminals and Codex non-TTY command cards. Other log-only pipes fall back to one
status line every 60 seconds.
Use `--verbose` only when task IDs and additional diagnostics are needed.

## First-time setup

New installations retain the complete four-step onboarding from the first
release: API Key, default quality, ratio, and image count. The plugin saves the
resulting quick mode locally, then resumes the user's original image request
without asking them to repeat it. Existing installations with a saved quick
mode keep the single-command fast path.

For requests such as “edit the previous image”, the fast path is:

```powershell
node <plugin-root>/scripts/generate.mjs --edit --latest-image --prompt "..."
```

## v0.1.3 更新内容

- 生图、改图收到明确需求后直接运行一条命令，不再先读配置或单独检查更新。
- “编辑上一张图”由 CLI 自动找到最近输出图片，不再让 Codex 花时间找路径。
- 不再强制准备 TTY；TTY 和 Codex 非 TTY 命令卡都保留单行动态计时，其他日志管道自动低频提示。
- 更新提醒继续保留，但已并入实际生图命令。
- CLI 直接输出 Markdown 图片行，Codex 无需再复制或编码结果文件。
- 完成后显示实际图片尺寸；上游返回尺寸与请求不一致时会明确告警。
- 增加最近图片编辑的模拟 API 全链路测试。

## v0.1.2 更新内容

- 生图和改图保留提示词、规格、动态计时与完成耗时，但不再解释内部执行流程。
- TTY 中的“生成中”秒数在同一行动态更新，不会每次新增一行。
- 非 TTY 环境采用每 60 秒一次的低频状态提示。
- 修复进度停在 `0s`，并取消默认自动验图。
- 插件详情页新增 [Subkkai 官网](https://subkkai.com/)。

## Updating existing installations

The plugin does not force a silent update or inject an arbitrary HTML popup.
After this version is installed, the skill performs a low-frequency version
check when it is used. If a newer manifest version is available, the user sees
a short notice in the Codex response and can reply **“更新插件”**.

The explicit update flow refreshes the marketplace snapshot and reinstalls the
plugin:

```powershell
codex plugin marketplace upgrade subkkai
codex plugin add subkkai-image-gen@subkkai
```

The check is best-effort, uses only version metadata, and is cached for 24
hours. It never sends prompts, images, or API keys. To disable it for a local
environment:

```powershell
$env:SUBKKAI_IMAGE_GEN_DISABLE_UPDATE_CHECK = "1"
```

Important first-rollout limitation: installations older than the version that
contains this checker cannot run it remotely. Those users need one manual
refresh/reinstall first; future releases can then notify them inside Codex.

For a local personal-marketplace checkout, update the Codex cachebuster before
reinstalling so the local cache is invalidated:

```powershell
python <codex-skill-root>\scripts\update_plugin_cachebuster.py <plugin-root>
codex plugin add subkkai-image-gen@subkkai
```

Read [CHANGELOG.md](CHANGELOG.md) before upgrading. The marketplace version is
the source of truth; the image-generation script never installs or replaces
itself.

## Configure a key safely

Do not put the full key in shell history or a command-line argument. Prefer
the skill's stdin flow. For CI, inject `SUBKKAI_IMAGE_GEN_API_KEY` through the
CI platform's secret store instead of typing it into an interactive command.

For interactive setup, the skill invokes:

```text
node <plugin-root>/scripts/generate.mjs --set-key-stdin
```

and supplies the key through stdin without echoing it into chat.

The local fallback configuration is stored under
`$CODEX_HOME/subkkai-image-gen-config.json` (default: `~/.codex/`). The file
is written atomically with restrictive permissions where the operating system
supports them.

## Supported operations

- Single-image generation and 1K/2K/4K size presets.
- Existing-image editing for PNG, JPEG, and WebP inputs.
- Direct editing of the newest generated image with `--latest-image`.
- Batch generation of up to 20 prompts with up to 10 workers.
- One-line live TTY progress with a sparse 60-second non-TTY fallback.
- Batch filenames numbered in prompt order (`img_01_...`, `img_02_...`).
- Local image output with bounded downloads and actionable, sanitized errors.

## Privacy and network behavior

Prompts and edit images are sent to the configured API Base. Generated image
URLs may be downloaded locally. Review the provider's retention, billing, and
privacy terms before using sensitive content. The optional update check makes a
small HTTPS request to the public GitHub manifest and stores only version/cache
metadata locally. Remote API bases must use HTTPS; HTTP is intended only for
localhost development or an explicit insecure opt-in.

## Development and verification

```powershell
npm run verify
python "$env:USERPROFILE\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py" plugins/subkkai-image-gen
```

The test suite uses a local mock HTTP server and does not call the paid image
API. A real generation smoke test still requires a valid user key and may
incur provider charges.
