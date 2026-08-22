# 测试、发布与贡献流程

## 本地验证

Backend 改动至少执行：

```powershell
npm run typecheck
npm test
```

协议、Provider、MCP、路径、审批、插件、Worktree、调度和持久化改动还要执行对应的 contract/integration tests。测试不应依赖真实 Provider Key、真实 Cookie、真实 MCP Header、真实 Harness 账号或用户工作区。

## 测试分层

| 场景 | 位置 |
| --- | --- |
| 纯函数、schema、store、registry | `tests/unit/<domain>/` |
| RPC payload、dispatcher、错误码 | `tests/contract/protocol/` |
| WebSocket、sandbox、MCP、运行时边界 | `tests/integration/<domain>/` |
| 插件、Harness、Worker、P2 | `tests/unit/plugins/` 与对应 runtime integration |
| 可复用 fixture | `tests/fixtures/` |

插件 fixture 必须覆盖：安装不执行生命周期脚本、manifest/fingerprint、整包信任、registry 原子提交、非法协议、sandbox unavailable、超时/崩溃熔断、P2 能力和 Harness 未知 Patch 警告。CI 使用假的 Worker/Sidecar，不要求本机安装 DeepSeek Harness。

## 安全回归清单

- 沙箱不可用时所有插件、Hook、Harness、语言服务都拒绝执行。
- 网络默认关闭，明确授权才可在安装流程临时开启。
- secret 不进入子进程环境、stdin、stdout、RPC 或日志。
- 插件工具仍经过 Tool Policy、Approval Gateway 和 Agent Loop。
- 整包信任、fingerprint 失效、Profile 启停和自动隔离行为正确。
- Harness 未知 Patch、动态 Cordis 和 `!!js` 只警告，不执行。
- 路径 traversal、符号链接/junction 逃逸、tarball 覆盖和工作区越界被拒绝。

## 发布前检查

1. 更新 `package.json`、协议版本和 release manifest。
2. 执行 typecheck、单元/合约/集成测试和 self-test。
3. 检查 npm package whitelist，确认不包含 `.daedalus`、日志、测试密钥或本机配置。
4. Windows SEA 构建后运行版本、health 和 sandbox capability 检查。
5. 生成 SHA-256 checksums 和 CycloneDX SBOM。
6. 在 Studio 与 Godot client 上验证协议版本拒绝和升级/回滚路径。

## 变更规则

新增 RPC、工具、Hook、插件能力或路径时，必须同时更新 schema、类型、handler、客户端封装、测试、错误码和中文文档。除非用户明确批准，不添加旧 RPC 兼容或数据迁移；不把大型业务逻辑继续堆入 `request-dispatcher.ts`、`main.ts` 或单个 handler 文件。
