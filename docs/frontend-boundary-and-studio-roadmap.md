# Godot 插件与 Daedalus Studio 边界路线

## 背景

Godot Daedalus 现在有三个运行面：

- Godot 前端插件：嵌在 Godot Editor 内，负责项目上下文、轻量聊天、审批、差异预览和与编辑器状态强相关的交互。
- TypeScript 后端：负责协议、会话、Provider、MCP Host、工具安全边界、审批、持久化和长任务调度。
- Daedalus Studio：独立 Electron/React 应用，适合承载更大的工作台体验，例如资产生成、生图、视频生成、批量任务、历史资产库和跨项目管理。

长期方向是让 Godot 插件保持轻量，不把所有 AI 工作台能力塞进 Editor Dock。Godot 插件只做编辑器内高频、短路径、强上下文的操作；更重的生成、预览、资产管理和多任务编排进入 Daedalus Studio。

## 产品定位

### Godot 插件

Godot 插件应该是“编辑器侧控制面”，不是完整 AI Studio。

保留在插件内的能力：

- 当前项目会话：问答、Agent 执行、审批继续、会话列表和恢复。
- 当前编辑器上下文：打开场景、选中节点、当前脚本、FileSystem 选择、场景截图、LSP/DAP 只读诊断。
- 小型编辑操作：文本修改、场景 patch、项目设置修改、Godot runtime lifecycle、检查和验证。
- Provider、模型、skill、MCP 等必要设置，但 UI 以轻配置为主。
- 对重任务的入口：把当前项目、当前会话、选中资源或截图发送到 Studio。

不应该继续扩进插件的能力：

- 生图、视频生成、长耗时媒体任务和批量任务队列。
- 大型资产库、结果画廊、版本对比、多变体筛选和收藏。
- 跨项目工作台、跨会话搜索、复杂知识库管理。
- 多面板工作流编排、节点式任务编辑器和大规模日志观测。
- 需要大量屏幕空间或后台持续运行的体验。

### Daedalus Studio

Daedalus Studio 应该是“独立 AI 工作台”。

优先承载：

- 多项目/多工作区管理：选择 Godot 项目、查看会话、打开最近任务。
- 大型聊天界面：完整 timeline、工具事件、审批、diff、计划、失败恢复。
- 资产生成工作台：图片、视频、音频、材质、Sprite、UI 图标、概念图、参考图。
- 生成结果管理：任务状态、输出资产、参数、prompt、模型、种子、版本、导入到项目。
- 后台任务：长任务队列、重试、取消、恢复、通知。
- 跨项目配置：Provider、密钥状态、模型、MCP、skills、缓存和诊断。

Studio 不应该绕过后端安全边界。它是更大的 UI，不是更高权限的执行器。

## 边界规则

| 决策问题 | 放在 Godot 插件 | 放在 Daedalus Studio |
| --- | --- | --- |
| 是否依赖 Godot 当前选中节点、打开场景或编辑器状态 | 是 | 可查看摘要，但不是主入口 |
| 是否需要宽屏、多列、画廊或复杂预览 | 否 | 是 |
| 是否超过几秒且需要后台运行、取消、恢复 | 只显示入口和状态 | 是 |
| 是否直接修改当前项目文件 | 可做，但必须审批 | 可做，但仍走同一审批 |
| 是否只是配置 Provider/API Key/Skill 开关 | 保留轻量版 | 提供完整管理页 |
| 是否生成大量二进制资产 | 不承载完整流程 | 是 |
| 是否需要跨项目搜索或批处理 | 否 | 是 |

## 后端契约

两个前端共享同一个后端协议，但能力声明不同：

- `clientType: "godot_editor_bridge"`：独立的 Godot 编辑器桥接客户端，使用 Editor Bridge Protocol v4 声明 editor context、inline diff、approval 和 workspace 绑定能力。
- `clientType: "studio"`：独立工作台客户端，声明大 timeline、approval、asset task、workspace management 等能力。

后端必须继续保持这些安全边界：

- LLM Provider 只能请求模型，不能直接执行工具。
- 工具执行、审批、read-only、路径约束、幂等继续留在 tools/approval 层。
- Studio 不能因为是桌面应用就获得越权路径访问。
- 生图、视频和其他媒体任务也要经过统一 task/job 模型，不能散落成前端本地状态。

建议新增或强化的协议对象：

```ts
type ClientSurface = "godot_editor_bridge" | "studio" | "studio_remote" | "cli" | "smoke";

type LongTaskKind =
	| "image_generation"
	| "video_generation"
	| "asset_import"
	| "batch_edit"
	| "project_analysis";

type LongTaskStatus =
	| "queued"
	| "running"
	| "approval_required"
	| "succeeded"
	| "failed"
	| "cancelled";

type LongTaskSummary = {
	id: string;
	workspaceId: string;
	sessionId?: string;
	kind: LongTaskKind;
	title: string;
	status: LongTaskStatus;
	progress?: number;
	createdAt: string;
	updatedAt: string;
};
```

第一版不需要一次实现完整长任务系统，但协议设计应避免把生图/视频硬塞进 `ai.chat` 的临时事件里。聊天可以创建任务、订阅任务、引用任务输出，但任务本身应有独立生命周期。

## 推荐下一步

### 1. 先稳定共享协议和 Studio 基础壳

目标：Studio 能稳定连接后端、选择工作区、打开会话、发送消息、渲染 timeline，并处理审批。

具体任务：

- 让 Studio 使用和 Godot 插件一致的 `client.hello` 工作区初始化语义。
- Studio 会话列表按 workspace 分组，打开会话前确认 workspace MCP 已准备好。
- 补齐实时事件订阅：assistant streaming、tool events、approval、inline diff、skill activated、catalog changed。
- 将 Provider/model/skill 设置页优先做在 Studio，Godot 插件保留轻量入口。

这是当前最值得做的一步，因为后续生图、视频、资产任务都依赖稳定的 Studio 与后端连接。

### 2. 把 Godot 插件瘦身为编辑器侧入口

目标：降低插件 UI 复杂度，减少响应时布局跳动和状态竞争。

具体任务：

- 保留聊天、审批、diff、设置、`@skill`、当前上下文选择。
- 删除或避免新增大型任务 UI，只提供“在 Studio 打开/继续”的入口。
- 插件显示长任务的简短状态，但详情和结果管理跳转 Studio。
- 设置页只保留运行必须项；高级配置在 Studio 完成后可从插件跳转。

### 3. 新增后端 Long Task/Asset Task 抽象

目标：为生图和视频准备统一任务模型。

具体任务：

- 新增 `task.create`、`task.list`、`task.get`、`task.cancel`、`task.subscribe` RPC。
- 任务持久化放入 `%USERPROFILE%\.daedalus`，按 workspace/session 关联。
- 任务事件可恢复，避免 Studio 重启后丢失进度。
- 输出文件写入项目前必须走审批或明确的导入动作。
- 大文件、二进制资产和缩略图使用 artifact metadata 管理，不直接塞进聊天事件。

### 4. 第一批 Studio 重能力：图片生成

目标：用生图验证完整链路。

建议范围：

- 文本到图、参考图到图、局部重绘可以先做其中一种。
- 先支持任务创建、进度、取消、结果预览、保存到外部目录。
- 再支持导入 Godot 项目，例如保存到 `res://assets/generated/...`，并走审批。
- 不在 Godot 插件内做完整画廊，只显示任务摘要和跳转。

### 5. 第二批 Studio 重能力：视频生成和资产库

目标：在任务系统稳定后再扩。

建议范围：

- 视频生成、任务队列、失败重试、批量变体。
- 项目资产库：图片/视频/材质/脚本片段/场景变体。
- 与 Godot 编辑器联动：从当前场景截图创建任务，把生成结果导入并选中。

## 近期优先级

建议按这个顺序推进：

1. Studio 连接和会话基础：先让 Studio 成为可用聊天客户端。
2. Studio 实时事件和审批：没有这个，重任务也无法安全落地。
3. 插件轻量化：收敛插件 UI，减少它承担 Studio 应该承担的复杂面板。
4. 后端 Long Task 协议：为生图/视频统一建模。
5. 图片生成 MVP：选择一个 Provider 或本地服务接口接入，验证任务、产物、导入、审批。
6. 资产管理和视频：等任务模型跑通后再做。

## 非目标

第一阶段不要做：

- 在 Godot 插件内实现完整生图/视频工作台。
- 绕过后端直接从 Studio 调 Provider 或写 Godot 项目文件。
- 在聊天事件里临时塞入所有长任务状态。
- 引入复杂市场、插件系统或远程资产库。
- 做多个互不兼容的任务/产物存储格式。

## 判断标准

每次新增功能前先问三个问题：

1. 这个功能是否需要 Godot Editor 当前上下文？如果是，插件可以提供入口。
2. 这个功能是否需要长时间运行、大预览或资产管理？如果是，主体应放 Studio。
3. 这个功能是否会修改项目或执行工具？如果是，无论来自哪个前端，都必须走同一后端审批边界。

这个边界能让 Godot 插件保持轻快，也能让 Daedalus Studio 有足够空间发展成完整 AI 工作台。
