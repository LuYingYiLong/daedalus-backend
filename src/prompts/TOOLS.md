# Prompt 可见工具能力说明

本文档说明 prompt 写作时如何描述工具能力。它不是权限来源；实际可用工具、风险分组和审批语义以代码为准：

- `src/tools/builtin-tool-definitions.ts`
- `src/workflow/planner.ts`
- `src/tools/tool-policy.ts`

## 风险分组

- `read`：读取代码、场景、配置、日志、编辑器上下文、诊断信息或会话状态，不改变项目文件和外部状态。
- `verify`：运行只读验证、类型检查、语法检查、诊断查询或健康检查。验证命令不得顺带安装、写入或修复。
- `propose`：生成预览、差异、建议或计划，但不直接落盘。
- `write`：创建、覆盖、替换、移动、修改文件、场景、项目设置、配置或外部状态。
- `destructive`：删除文件、清理目录、终止进程、重置状态、执行不可逆或高风险操作。
- 自定义 MCP：外部用户配置的 MCP 工具集合，能力和风险必须由工具策略和审批流程兜底。

## 模式边界

Agent 模式：

- 可以按 workflow、tool budget、tool policy 和审批策略使用 read、verify、propose、write、destructive 工具。
- 高风险工具仍必须遵守审批、幂等和事件恢复边界。
- 调用 write/destructive 工具时，如果工具 schema 提供 `approvalReason`，必须填写一句面向用户的具体原因，说明为什么需要执行以及会产生什么影响。
- 自定义 MCP 只能在工具策略允许时开放。

Ask 模式：

- 只能使用内置 read + verify 工具，用于读取上下文、分析问题和运行只读验证。
- 不开放 write、propose、destructive 工具。
- 不开放自定义 MCP sentinel，避免外部工具绕过只读顾问边界。
- 即使前端传入更高权限的 tool budget，后端也必须按 Ask 模式强制收窄。

## Prompt 写法

- 描述工具时只写能力边界，不列举会随代码变化的完整工具名清单。
- 不在 prompt 中承诺某个工具一定可用；最终可用性由后端 registry、workflow 和 policy 决定。
- 当工具能力与用户要求冲突时，优先遵守模式边界和审批策略。

## Agent Loop 与 workflow 工具

- 复杂问题应优先使用后端提供的 workflow 相关 read、verify、propose、write 和审批工具来获取证据、推进修改和验证结果，同时保持自由 Agent Loop 的自主调度，不假设固定阶段顺序。
- `daedalus_prepare_summary` 是总结前检查工具，只能在有用工作和必要验证完成、模型准备开始写最终用户答复时调用；规划、进度播报或工作尚未完成时不要调用。若返回 `action=continue_agent_loop`，继续处理或如实说明阻塞；只有返回 `action=summarize` 后才开始最终总结，并遵循其中的 warnings。
