# Backend 运维、诊断与恢复

## 数据目录

所有 Daedalus 自有路径由 `src/app-paths.ts` 注册，默认位于 `%USERPROFILE%\\.daedalus`：

```text
backend/                 Backend 版本、current marker、更新状态
config/                  Provider、模型、Workspace、Hooks 等非 secret 配置
sessions/                Session metadata、timeline、附件和 Agent Run
plugins/packages/        当前已安装插件包
plugins/versions/        手动更新保留的历史版本
plugins/runtime/         Worker/Harness 隔离运行目录
plugins/quarantine/      隔离记录
plugins/events.json      有界 Plugin Event Bus 记录
logs/                    脱敏运行诊断
```

不要提交、复制或公开整个 `.daedalus`。诊断包必须先移除项目名、绝对路径、提示词、附件、模型输入和所有 secret。

## 启动检查

Backend 启动时会：

- 校验配置和 records/Profile/Trust 引用关系；损坏文件保留副本后使用安全空配置。
- 清理没有活动 Runtime 的临时目录。
- 恢复可验证的 Worktree runtime workspace；缺失时标记 unavailable/recovery-required。
- 清理不存在插件 ID 的 Profile 项。
- 不恢复运行中的 Worker、Harness Sidecar、Hook 或 Agent Run。

## 常见状态

### `sandbox_unavailable`

表示 OS sandbox helper 未配置、路径非法或不可执行。插件、Hook、Harness 和语言服务会拒绝启动，这是硬性安全行为，不是可通过宿主机回退解决的普通警告。Windows 发布包会随 Backend 一起携带 `daedalus-windows-sandbox-helper.exe`，Studio 启动时自动注入其绝对路径；源码开发时先执行 `npm run build:sandbox-helper:win`，再重启 Backend。Backend 也只会在受控的 `build/`、SEA payload 或可执行文件旁边自动发现固定文件名的 helper。辅助程序遇到 `Program Files` 中的 Node 等系统运行时，会先复制到临时受控目录再启动，避免修改系统目录 ACL。也可以显式设置 `DAEDALUS_WINDOWS_SANDBOX_HELPER`，但必须指向绝对、非符号链接的 helper 文件。

### `review_required` 或 fingerprint 失效

包内容、入口、lockfile、Harness 配置、Bridge 版本或 capability 发生变化后需要重新审核。不要直接修改 trust 文件；重新扫描并在 Studio 的信任审核中确认整包能力。

### `quarantined`

同一插件/会话 5 分钟内达到 3 次启动失败、崩溃、超时或协议错误后进入隔离。先查看脱敏运行日志和资源统计，修复包或配置后使用“解除隔离并重试”。重复达到阈值会再次隔离。

### Harness `needs_setup`

Backend 只检测用户明确配置的已安装 Harness 或源码目录，不自动下载或执行 `npm/pnpm install`。缺少入口、依赖或 Bridge 时显示 needs_setup；用户修复后重新检测。运行期间网络仍默认关闭。

## 运行时诊断

推荐按顺序执行：

```powershell
npm run typecheck
npm test
npm run self-test
godot-daedalus-backend --json version
```

开发环境可查看 plugin runtime snapshot、active/pending calls、RSS、退出码和最近 100 条脱敏日志。生产环境不持续打印内存或插件 stdout；需要诊断时使用显式诊断开关或 Studio 的日志面板。

## 更新、回滚与清理

插件更新必须由用户手动触发。新包先写入 staging，扫描和 fingerprint 校验成功后才停止旧 Runtime、保留上一版本并原子更新 records/Profile/Trust。新版本启动失败时使用 Plugins 页面回滚；禁止直接删除当前 package 或手改 metadata。

删除插件前必须停止 Runtime、取消 pending calls、移除 Profile 和 registry。隔离目录、staging 和历史版本只由 Backend 的受控清理流程操作，禁止对整个 `.daedalus` 执行递归删除。

## Worktree 与定时任务

Worktree 删除、Handoff 和 repair 必须先确认没有活动响应、审批、后台任务或绑定 PTY。调度任务使用独立 Studio 存储和 capability，不应被外部 MCP 或 `studio_scheduler` 客户端任意修改。错过的任务合并补跑，不通过命令行参数传入用户提示词或 secret。
