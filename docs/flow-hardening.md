# Flow 运行与产物硬化

Flow 文档、已有运行和媒体产物继续保存在本机。数据库升级到 31 时创建普通媒体节点的提交尝试记录和节点阶段事件；打开数据库不会直接改写运行状态。服务启动后再单独恢复被中断的运行。

## 中断后的处理

| 持久状态 | 启动后的动作 |
| --- | --- |
| 节点或批量条目尚未提交 | 继续调度 |
| 已取得 Provider Job ID | 查询原任务，不重新创建任务 |
| 产物已保存但节点结果未提交 | 核验引用并采用已保存的结果 |
| 已提交但没有可靠 Job ID | 标记 `media_submission_uncertain`，停止自动提交 |
| 节点已完成 | 保留输出，继续可独立执行的分支 |

`flow.run.retry` 遇到不确定的付费请求时返回 `flow_paid_retry_confirmation_required`。调用方只有在明确向用户说明可能重复计费后，才可发送 `confirmPossibleDuplicateCharge: true`。批量重试继续复用已成功的条目；保存文件的幂等记录不会因恢复而重写已保存文件。

## 媒体与归档

单项导入和写出使用临时文件、哈希校验与原子提交。启动审计报告数据库引用的缺失／损坏文件及残留临时文件，不自动删除历史结果。Studio 的视频和大图预览使用本地媒体协议的 Range 流，WebSocket 的 base64 读取限于小文件。

Flow 导出格式版本为 3，文件扩展名为 `.daedalus-flow`。归档由格式头、独立 SQLite 快照和顺序媒体文件组成，导入时检查版本、单项与总大小、条目数量、路径和 SHA-256。旧 SQLite Flow 导出文件不能导入新版。最多 10,000 个产物、单项 512 MiB、整个包 2 GiB。清理需要先预览运行和产物，再提交相同的产物 ID 集合；存储超过 20 GiB 或剩余空间偏低只提醒，不自动清理。

归档导入和导出函数接受可选的 `AbortSignal`。Studio 传入操作 ID，可在导入按钮旁或 Flow 树右键菜单中取消。取消时中断媒体流，删除临时文件；导入尚未提交的数据库记录会回滚，导出目的地原有文件保持不变。

按需运行 1 GiB 流式内存检查：

```powershell
$env:RUN_FLOW_ARCHIVE_1GIB = '1'
node --import tsx --test tests/performance/flow-archive-memory.test.ts
```

该检查分别测量归档流式读写，以及包含四个 256 MiB 产物的完整 Flow 导出和导入；两项都要求进程 RSS 增量不超过 256 MiB。正常 `npm test` 跳过这项磁盘压力检查。
