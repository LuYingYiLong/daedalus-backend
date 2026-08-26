# 插件平台与开发规范

本文描述 Daedalus Native Plugin、DeepSeek Harness Bundle 和 P2 扩展能力。插件只在受控沙箱 Worker/Sidecar 中运行；Backend 主进程和 Renderer 都不直接 import 第三方插件代码。

## 插件来源与安装

P0 支持本地目录、`.tgz`、精确 npm 版本和固定 Git commit。安装过程先进入 staging，再扫描 manifest、入口、lockfile、路径和内容 hash，最后原子提交到 `%USERPROFILE%\\.daedalus\\plugins`。

- npm/Git 使用 argv，不拼接 shell 命令。
- 生命周期脚本始终关闭：不得执行 `install`、`prepare`、`postinstall`。
- tarball 的路径穿越、重复覆盖、符号链接和 junction 逃逸必须拒绝。
- 安装失败不得留下半成品记录或临时目录。
- 安装完成默认 `review_required`，不会自动执行插件代码。

## Native manifest

最小 Native manifest：

```json
{
  "daedalus": {
    "plugin": {
      "apiVersion": 1,
      "entry": "./dist/index.js",
      "capabilities": ["tools", "skills", "hooks", "mcp"]
    }
  }
}
```

入口只允许通过 Worker 协议注册能力。Tools、Skills、Hooks 和 MCP 使用 `plugin:<pluginId>:...` 命名空间，不能覆盖内置或其他插件的注册。

## P2 manifest 与能力

当前 P2 manifest API version 为 2。P2 能力包括 Slash Commands、声明式 Panel/Settings、Timeline Part、Browser、Monaco Language Service 和 Event Bus。每种能力拥有独立 API version；某个能力不兼容时只禁用该能力，不把不兼容声明伪装成可用能力。P2 v1 不再被接受。

Renderer 只渲染白名单 JSON UI：`Text`、`Icon`、`Tag`、`Alert`、`Descriptions`、`Input`、`Select`、`Switch`、`Button`、`List`。插件 UI 不得访问 Electron、原始 RPC client、WebContents、文件系统或 Backend 内部对象。

Browser 只能调用固定导航、观察、滚动、输入、点击、下载和标签页接口；Language Service 使用受限子进程和 LSP Proxy。插件 Timeline Part 不能伪造用户、助手、系统或审批事件。

## Harness Bundle

`dsh.bundle.patch` 只做有界静态解析和能力摘要。`insert`、`replace`、`override` 之外的行逐行跳过并警告；未知 Patch、动态 Cordis `inject`、动态模块和 `!!js` 绝不执行或模拟。`dsh.client` 只做静态兼容识别，不注入 Browser Panel。

转换为 Native 时，仅转换静态可确认的 Tools、Skills、Hooks、MCP 和展示元数据。转换报告纳入 fingerprint；存在未知或不可转换能力时继续使用受信任 Harness Sidecar，Sidecar 不可用时不得回退宿主机或 Native 未授权路径。

## 信任、Profile 与运行时

信任按整个插件包审核，P0/P1/P2 都不提供单个工具级信任。只有以下条件同时满足时能力才会暴露：

```text
trust = trusted
Profile 已启用
fingerprint 仍然有效
插件未被隔离
OS sandbox 可用
```

插件运行时默认禁网。联网只允许用户在信任/安装依赖等明确流程中选择开启；运行期间不得继承网络权限。插件进程不能获得 Provider API Key、MCP Header、Cookie、密码、Keytar 或宿主机凭据。

所有插件工具继续经过 Tool Policy、Approval Gateway 和 Agent Loop，不能通过插件、Harness、Hook、MCP 或 P2 action 绕过审批、跨工作区限制、硬性 consent 或无沙箱限制。

## 资源、故障与回滚

每个插件/会话最多 4 个并发调用、16 个排队调用；Worker 默认 RSS 上限 256 MiB，Harness Sidecar 默认 512 MiB；10 分钟无调用时回收空闲运行时。5 分钟内累计 3 次启动失败、崩溃、超时或协议错误后自动隔离，后续能力从目录移除，用户必须明确解除隔离。

更新必须手动触发，先保留上一版本，再原子切换 records、trust 和 Profile。新版本首次启动失败时提供回滚，不能静默改用旧版本或宿主机执行。

## 插件开发检查清单

- 使用稳定的命名空间和显式 capability 声明。
- 所有 schema、输出、描述、Skill 正文、事件 payload 都限制大小和深度。
- 不在 stdout 输出非协议内容；普通诊断写入脱敏 stderr/运行日志。
- 不读取 secret、Cookie、密码、完整工具结果或未授权工作区。
- 为每个工具声明保守风险级别，并准备审批后的失败路径。
- 为禁用、断线、取消、超时和 Backend 重启实现幂等清理。
- 使用 `tests/fixtures` 中的 fixture plugin 覆盖安装、信任、Worker、P2 registry 和失败恢复。
