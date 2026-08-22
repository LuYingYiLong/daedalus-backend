# Backend WebSocket/RPC 协议

## 传输与认证

Backend 默认只监听本机地址。Studio 由共享 runtime registry 获取短期认证 token 和 connection id；请求必须来自已认证的 WebSocket connection。外部 MCP 使用独立 facade，不得绕过 Backend 的认证和 RPC 边界。

当前协议主版本为 v3。客户端必须声明 `clientType`、插件协议版本和 capability；Backend 对不兼容版本返回明确错误，不进行旧协议兼容或 best-effort 降级。

## 校验顺序

所有外部输入必须在 `src/protocol/schema.ts` 通过 Zod schema 校验，并使用 `.strict()` 拒绝未知字段。dispatcher 之后还要校验：

- 当前连接是否有权限调用该方法；
- session/workspace/source folder 是否属于当前连接；
- 路径、browserId、pluginId、queueId 和 operation id 是否在当前边界；
- 写操作是否经过 Tool Policy 和 Approval Gateway。

协议 handler 不应直接信任前端传入的标题、路径、命令、模型或状态；必须使用 Backend 当前事实重新解析。

## RPC 命名

请求方法按领域命名，例如 `session.open`、`workspace.list`、`provider.modelSelection.get`、`plugin.catalog.list`。长任务使用 operation snapshot 和 transient event，而不是让一个 RPC 无限等待。

RPC 失败返回稳定的错误 code、脱敏 message 和必要的 retryable 标记。原始 shell 输出、Provider API Key、MCP Header、Cookie、密码和环境变量不能出现在 RPC 返回或日志中。

## Studio 专用 capability

以下能力只能向受信任 Studio connection 暴露：

- Browser tool request/result/cancel；
- Scheduled Task tool bridge；
- 插件安装、信任、运行时和 P2 registry；
- Worktree 生命周期管理；
- File/Monaco 和 Browser Panel 运行时桥接。

Backend 只把 capability 声明作为“可以尝试调用”的条件，最终仍要检查插件信任、Profile、fingerprint、沙箱和当前会话状态。

## Transient event

模型或后台运行需要 Studio 参与时，Backend 发送有界的 transient event，并用 `callId`/`runId` 关联结果。结果只能由收到请求的同一 socket 提交；断线、取消、超时或会话关闭时清理 pending map。

插件、Browser 和 Scheduled Task 的 event payload 必须限制帧大小和字段深度。截图、图片和其他二进制数据使用附件/多模态通道，不能把 base64 写进普通 timeline 文本。

## 版本与变更

新增 RPC 必须同时更新：

1. `src/protocol/types.ts`；
2. `src/protocol/schema.ts`；
3. dispatcher/handler；
4. Studio 或 Godot client API；
5. protocol contract tests；
6. 中文文档和错误码说明。

协议变更默认不做旧数据迁移和旧 RPC 兼容。需要不兼容变更时，先更新版本合约和 Studio/backend release manifest，再修改实现。
