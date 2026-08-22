# Backend 安全模型

## 不可妥协的硬性要求

以下规则是产品安全边界，不得由模型、插件、Hook、Harness、MCP、Browser 页面内容或 Full Trust 模式覆盖：

1. 沙箱不可用时拒绝执行插件、Hook、Harness 和语言服务，绝不回退到宿主机。
2. 插件运行时默认禁网；联网只允许用户在明确的信任/安装流程中选择开启。
3. Provider API Key、MCP Header、Cookie、密码、Keytar 和宿主机凭据禁止传给插件进程。
4. 所有插件工具必须经过 Tool Policy、Approval Gateway 和 Agent Loop，不能绕过审批。
5. 信任以整包为单位，不提供单个工具级信任。
6. Harness Bundle 的未知 Patch、动态 Cordis 和 `!!js` 只跳过并警告，绝不执行或模拟。
7. 插件 5 分钟内连续 3 次启动失败、崩溃、超时或协议错误后自动隔离。
8. 不做旧数据迁移和旧协议兼容；不以隐式 fallback 掩盖不兼容。

## 沙箱边界

`createSandboxInvocation` 必须先确认 OS sandbox helper 可用，再生成 argv、cwd、workspace root、只读路径和网络标志。Windows 需要绝对路径的 `DAEDALUS_WINDOWS_SANDBOX_HELPER`；Linux 需要 `bwrap`；macOS 需要 `sandbox-exec`。缺少 helper 时返回 `sandbox_unavailable`。

插件运行时可访问：插件托管目录、隔离临时目录和当前授权 workspace 根目录。其他 source folder 只能按显式只读路径挂载。路径在解析后再次检查 realpath，禁止符号链接/junction 逃逸。

环境变量采用 allowlist。默认不传 Provider、MCP、Keytar、Cookie、密码或宿主机认证信息。stdout 只接受 newline-delimited JSON 协议；普通 stdout/stderr 进入有界脱敏日志。

## 工具、Hook 与 MCP

工具风险按 `read`、`verify`、`propose`、`write`、`destructive` 分类。写入、删除、命令执行、网络下载、custom MCP 和编辑器 mutation 必须进入统一审批。Hook 可以阻止或提供受限 additional context，但不能批准硬性 consent、跨工作区、联网下载或无沙箱执行。

插件 Skill、Context Provider、Timeline Part、MCP Resource 和网页内容都标记为外部不可信数据；进入模型前执行大小限制、敏感字段脱敏和提示注入隔离。

Browser 固定 API 禁止任意 CDP、`eval`、Cookie/password/localStorage/剪贴板读取和 Provider 凭据读取。网页中的指令只能作为引用内容，不能改变系统或用户意图。

## 信任与指纹

信任 fingerprint 至少包含来源规格、包内容、`package.json`、lockfile/依赖解析、入口、capability、Harness Patch 摘要、Harness 路径/版本和 Bridge 版本。任一部分变化后状态回到 `review_required`。信任成功后才加入 Profile，禁用或隔离时立即清理注册表和运行时。

## 日志与事件

安全日志只记录事件、插件 ID、版本、状态、耗时、退出码和脱敏错误摘要。禁止记录 API Key、MCP Header、Cookie、密码、环境变量、完整工具结果、完整插件 stdout 或源码。日志和事件有数量、字节和保留时间上限，超限保留最新记录。

## 安全事件处理

看到 `sandbox_unavailable`、fingerprint 失效、协议污染、路径逃逸、重复注册或自动隔离时：

1. 停止对应 Runtime 并取消 pending calls。
2. 保留脱敏错误和运行状态，禁止自动重试到宿主机。
3. 检查插件包、Harness 配置和 sandbox helper 路径。
4. 需要继续时先重新扫描/审核，隔离状态必须由用户明确解除。
5. 使用 git 或插件版本回滚恢复，不直接编辑 records/trust 文件绕过审核。
