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
- Batch generation of up to 20 prompts with up to 10 workers.
- Status-change progress feedback while a task is queued or processing.
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
