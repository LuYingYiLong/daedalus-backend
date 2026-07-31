# Godot Daedalus 公开 Beta 发布清单

目标：在公开给普通 Godot 用户前，确认后端、manager、插件、发布包和回滚路径可以稳定工作。Beta 首要支持 Windows + Godot 4.5 或更高版本。

## 自动门禁

在 `D:\godot-daedalus_backend` 执行：

```powershell
npm ci
npm run check
npm run smoke:beta
```

`npm run smoke:beta` 会启动本地后端，运行 Godot headless 脚本检查，并执行 `backend.health` WebSocket smoke。可通过环境变量覆盖：

```powershell
$env:GODOT_EXECUTABLE_PATH = "D:\Godot_v4.5.1-stable_win64.exe\Godot_v4.5.1-stable_win64.exe"
$env:GODOT_PROJECT_PATH = "D:\GodotProjects\example"
$env:GODOT_DAEDALUS_PLUGIN_DIR = "D:\GodotProjects\example\addons\godot_daedalus"
```

真实 provider 写文件和 inline diff 快照可用单独 smoke 覆盖。它会真实调用 LLM、真实写入一个带时间戳的 `scripts/daedalus_inline_diff_smoke_*.gd` 文件，并且只自动批准该 smoke 文件相关写入：

```powershell
$env:DAEDALUS_DEEPSEEK_API_KEY = "<your key>" # 可选；已在 keytar 配好时不用传
npm run smoke:llm -- use_llm provider=deepseek model_id=deepseek-v4-pro project=D:\GodotProjects\example
```

开发时也可以用快捷入口：

```powershell
npm run dev:llm -- model_id=deepseek-v4-pro
```

## 手动验收

- 从干净 `%USERPROFILE%\.daedalus` 启动 Godot，启用 `GodotDaedalus` 插件；若机器上存在旧 `%APPDATA%\.godot_daedalus` 开发安装，也一并清理或确认不会被 fallback 命中。
- 打开 Backend Manager，确认 backend install、start、health、stop、rollback 都返回可读结果。
- 在 Settings 保存至少一个真实 provider API Key，刷新模型列表，完成一次真实纯文本对话。
- 切换 Ask 模式，确认不会执行写工具。
- 在 Agent 模式执行一次只读项目查询，确认工具结果可读。
- 触发一次写操作审批，分别验证 Approve 和 Reject；Reject 不得写入项目。
- 对测试场景执行一次场景修改或脚本写入，随后运行 Godot check-only 或 LSP diagnostics。
- 对 `smoke:llm` 生成的测试文件打开会话，确认 assistant 消息底部出现 inline diff；点击 Undo 后文件恢复，并确认 Godot Undo/Redo 栈表现正常。
- 重启 Godot 和 backend，确认 session、pending approval、provider 状态不会异常丢失。
- Stage 一个前端插件更新包，验证 apply-wait 在 Godot 关闭后成功应用；再验证 frontend rollback。
- 模拟 backend 端口被非 Daedalus 服务占用，确认插件/manager 展示可读错误和建议。

## 发布包规范

- 后端发布前必须通过 `npm run check` 和 `npm publish --dry-run`。
- 前端 release 必须附带：
  - `godot-daedalus-plugin-vX.Y.Z.zip`
  - `godot-daedalus-plugin-vX.Y.Z.manifest.json`
- 前端 zip 必须包含 `addons/godot_daedalus/plugin.cfg`。
- manifest 必须包含 `version`、`tag`、`sha256`、`assetName`、`minGodotVersion`。
- `plugin.cfg` 版本、manifest 版本、GitHub tag 必须一致。

## 安全回归

- API Key 和 custom MCP secret 只能进入 OS secret store，不得出现在 repo、日志、`provider.json` 或前端 RPC 返回中。
- `read-only` 模式不得执行 write/destructive/custom MCP 写操作。
- `destructive` 工具即使在 bypass 模式也必须审批。
- `res://`、`user://` 和绝对路径必须限制在允许根目录内，并默认脱敏本机隐私路径。

## 已知限制模板

发布 Beta 时在 release notes 中列出：

- 首要验证平台：Windows + Godot 4.5（最低兼容版本），并补测当前最新稳定版。
- macOS/Linux 暂不作为 Beta 阻断平台。
- 真实 LLM 调用依赖用户自己的 provider API Key 和网络环境。
- 如果插件更新遇到文件锁，关闭 Godot 后重新执行 pending update。
