# Flow 灰度示范插件

在 Studio 插件设置中选择本地目录安装，选择此目录，核对插件信息后信任并启用。插件声明 `flowNodes`、`flowMedia` 和 `flowTypedValues`，不需要工作区文件权限、网络或 API Key。

添加 `Grayscale` 节点，连接「读取图片／首张图片 → Grayscale → Media Output」。在输出中查看灰度图片。`index.js` 注册执行器，`definition.js` 描述控件和端口，`package.json` 的静态声明必须与注册信息完全一致。修改协议声明后同时修改两处并重新加载插件。

执行器接收 `{ config, inputs, context, signal, host }`。媒体通过 `host.processImage(artifactId, operation)` 处理，返回宿主保存的产物引用。只允许使用当前节点输入的 artifact ID；其他 Flow 的 ID、绝对路径和未声明操作会被拒绝。取消信号由宿主传播。

宿主支持 `normalize / resize / crop / rotate / composite / convert / grayscale` 的严格参数 schema；本插件只使用 `grayscale`。组合操作需要明确的第二输入授权，当前插件代理不开放任意文件叠加。

开发验证：运行后端 `npm test`，检查 manifest 与 Worker 注册一致、非法输出被拒绝、未声明 flowMedia 无法调用宿主、禁用后节点保留但不可执行。不要将图片字节或本机路径写入节点配置。

`types.d.ts` 给出此示例使用的最小类型契约；完整操作 schema 位于后端 `src/media/image-processing.ts`。调试时查看 Studio 插件运行日志，按 Flow Run / Node ID 对应错误；无需开启网络或授予工作区写权限。修改文件后重新安装并信任新的指纹，已有节点的版本锁不会静默升级。
