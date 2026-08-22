# Backend 架构与生命周期

本文是 Daedalus Backend 的架构入口。运行时代码在 `src/`，协议边界在 `src/protocol/`，测试在 `tests/`。如果实现与本文冲突，以当前协议 schema、运行时代码和测试为准；文档变更必须同步更新对应的测试说明。

## 运行时边界

Backend 是本机常驻的 TypeScript 服务，Studio、Godot 插件、CLI 和外部 MCP 通过版本化 WebSocket/RPC 连接。连接建立后依次经过：

1. 本地连接认证和客户端类型校验。
2. RPC envelope 与 payload 的 Zod 校验。
3. 会话、工作区和 capability 绑定。
4. 专用 handler 调度。
5. Tool Policy、Approval Gateway、Agent Loop 和持久化状态机。

模型输出、插件输出、网页内容、Skill 内容和 Hook additional context 都是不可信数据，不能改变系统提示、审批规则、工具边界或工作区边界。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/server/` | WebSocket、连接状态、RPC dispatcher、transient event |
| `src/protocol/` | 协议类型、schema、错误和 capability 合约 |
| `src/session/` | 会话 metadata、timeline、附件、Agent Run 和恢复 |
| `src/providers/` | Provider catalog、模型发现、请求适配和 token 预算 |
| `src/tools/` | 工具定义、风险分类、幂等、审批和事件展示 |
| `src/workflow/` | 复杂任务规划、执行、修复和验证循环 |
| `src/workspace/` | Workspace/source folder、Git、Worktree 和路径边界 |
| `src/mcp/` | 内置 MCP、custom MCP、终端和 Godot bridge |
| `src/hooks/` | 命令 Hook 配置、信任、沙箱执行和生命周期决策 |
| `src/plugins/` | 插件发现、信任、Worker、Harness Sidecar 和 P2 registry |
| `src/prompts/`、`src/skills/` | 系统提示、内置 Skill 和工具集合 |
| `src/app-paths.ts` | Daedalus 配置、会话、插件、日志和临时目录的 Path Registry |

插件能力必须通过 `src/plugins/` 的适配器接入，不得把第三方代码 import 到 Backend 主进程，也不得直接修改内置工具映射。

## Agent Run 生命周期

每个请求都有持久化 Agent Run。根据风险和复杂度选择 `direct`、`read`、`probe`、`lightweight` 或 `workflow` lane。工具调用顺序通常为：工具目录 → Tool Policy → Hook → Approval Gateway → 沙箱执行 → 结果脱敏 → timeline/模型上下文。

成功的写操作使用幂等键和写入指纹。重连或重试不会自动重复已经提交的写入；活动运行在 Backend 重启后标记为 interrupted，用户必须显式继续或重试。

## 工作区与会话

- Workspace 是 source folder、workspaceLaunch、Git 和运行时工具的安全边界。
- `res://`、绝对路径、生成路径和 Worktree 路径都必须经过最终 realpath 边界检查。
- Worktree 会话只访问托管 worktree runtime workspace；工作树缺失或健康检查失败时进入 unavailable/recovery-required，不能静默回退源目录。
- 会话偏好、Composer 草稿、Browser/File/Terminal 面板状态由 Studio 或会话布局管理；Backend 只保存协议定义的持久化字段。

## 插件运行时

插件分为静态记录和按需运行时：

1. 扫描来源并计算 manifest/content fingerprint。
2. 用户整包审核并加入全局 Profile。
3. 首次需要能力时启动 Native Worker 或 Harness Sidecar。
4. 先在临时 registry 收集注册，校验通过后原子替换正式 registry。
5. 会话切换、禁用、取消、断线或空闲回收时清理进程与 pending calls。

沙箱不可用时插件、Hook、Harness 和语言服务一律拒绝执行，绝不使用宿主机回退。插件故障按 `pluginId + sessionId` 统计，5 分钟内达到 3 次启动失败、崩溃、超时或协议错误后自动隔离。

## 启动与关闭

启动时加载 Path Registry、配置和插件静态记录，清理无活动 Runtime 的临时目录，并恢复可验证的 Workspace/Worktree 状态。不会恢复运行中的 Worker、Sidecar 或 Agent Run。

关闭时先取消 pending calls、后台 Hook、Browser/语言服务和插件 Runtime，再关闭会话与 WebSocket。关闭流程不得写入 secret 或完整工具结果日志。
