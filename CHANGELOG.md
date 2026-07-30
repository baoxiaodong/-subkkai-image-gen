# Changelog

## 0.1.4 - 2026-07-30

- 保留可靠的 `image-tasks` 异步接口，避免长时间直连请求在结果返回前断开。
- 将任务轮询从最高 8 秒的指数退避改为 250 毫秒固定间隔，减少上游完成后的本地发现延迟。
- 为请求增加 30 秒超时和瞬时网络错误、429、5xx 查询重试；任务创建不自动重试，避免重复扣费。
- 精简生成与编辑请求参数，移除不必要的 `quality`、`moderation` 和 `output_format` 字段。
- 任务失败、超时和过期错误现在包含任务 ID 与最后状态；`skipped_mainline` 会安全重试一次。
- 校验服务端返回的轮询地址必须与 API Base 同源，避免认证信息被发送到其他主机。
- 修复测试文件与实际脚本不匹配导致的导入失败，重建任务提交、轮询、编辑、重试和保存链路测试。
- 更新插件详情、官网地址和 Skill 接口说明；版本检查与包校验覆盖新的任务模式实现。

## 0.1.3 - 2026-07-27

- 将单图生成和编辑改为真正的一条命令快速路径，不再预先执行配置读取、目录扫描或单独更新检查。
- 新增 `--latest-image`，可直接编辑输出目录中最近生成的图片，避免 Codex 自行查找文件路径。
- 更新检查并入生成/编辑命令，继续保留版本提醒，但不再增加一个前置命令。
- 取消 Skill 对 PTY/TTY 的强制要求；TTY 与 Codex 非 TTY 命令卡都保留单行动态计时，并在完成前留下最后一条进度行。
- 恢复首版首次安装的四步向导：API Key、画质、比例、数量；已完成设置的用户仍保持一条命令快速生图。
- CLI 直接输出可展示的 Markdown 图片行，禁止 Codex 完成后再复制、Base64 编码或额外验图。
- 保存后读取 PNG/JPEG/WebP 的实际像素尺寸；与请求尺寸不一致时明确显示两者差异。
- 新增“编辑最近图片”模拟 API 全链路测试及无历史图片的即时错误测试。

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
