# Changelog

## 0.1.2 - 2026-07-27

- 精简单图生成与图片编辑流程，保留提示词预览、画质、比例、尺寸和完成耗时。
- 新增 TTY 单行动态计时，秒数原地刷新；非 TTY 环境每 60 秒提示一次。
- 隐藏配置检查、任务 ID、命令复述等技术细节，避免重复刷屏。
- 默认不再自动验图，只有用户明确要求时才检查或评价生成结果。
- 修复进度长期停留在 `0s` 的显示问题。
- 插件详情页新增 [Subkkai 官网](https://subkkai.com/)。

## 0.1.1 - 2026-07-27

- Fixed marketplace skill and icon paths.
- Added strict configuration, API Base, prompt, image, and batch validation.
- Added safe stdin/TTY API key setup, atomic local config writes, and redacted diagnostics.
- Added request timeouts, bounded retries, safe redirects, and atomic image output.
- Added task status feedback and stable batch output numbering.
- Added mock API tests, package validation, and cross-platform CI.
- Added a cached, privacy-preserving Codex update notice with an explicit
  marketplace refresh/install flow.

## 0.1.0

- Initial Subkkai image generation marketplace plugin.
