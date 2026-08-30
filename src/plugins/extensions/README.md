# 插件扩展能力

集中管理插件对 Studio 和 Backend 的声明式扩展：命令、面板、设置、时间线、浏览器、语言服务和事件总线，以及 UI 状态和原生转换报告。

- `protocol.ts`：扩展声明 schema 与类型
- `registry.ts`：已信任且启用的扩展能力注册表
- `event-bus.ts` / `ui-state.ts`：事件投递与声明式 UI 状态
- `language-service.ts`：插件语言服务生命周期
- `native-converter.ts`：Harness Bundle 原生转换报告

目录原名 `p2` 来自实施阶段编号。插件清单中的 `p2` 字段、API 版本、现有类型名与持久化文件名保持兼容；目录重命名不迁移或重置用户插件数据。
