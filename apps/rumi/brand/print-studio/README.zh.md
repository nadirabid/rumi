# Print Studio

[English](README.md) | 中文

为 Rumi 的 3D 打印工作流提供环境检测和 Bambu Lab 配置引导。

此功能涵盖环境配置和实际测试打印，回答三个配置问题，并提供一条端到端打印路径：

- 是否已安装 Bambu Studio？
- 是否包含 H2D 配置文件？
- 是否已配置打印机，并且可通过局域网访问？

主机端通过 SSDP 发现打印机，提供 `GET /api/print-studio/status`、`/api/print-studio/cloud/*` 下的 Bambu Cloud 路由、`/api/print-studio/viewer/*` 下的网格预览路由，以及面向模型的工具。登录会获取已绑定打印机的 `dev_access_code`；Bambu Connect 负责发送切片后的任务。浏览器端包括**插件 → 内置插件设置**中的 Print Studio 卡片和 3D 预览标签页。内置的 `skills/print-studio-setup/SKILL.md` 在加载时注册，以便智能体根据检测结果引导成年人完成配置。

打印机 IP 和序列号存储在 `$DSH_HOME/print-studio/printer.json` 中，仅所有者可访问。局域网访问码通过 `ctx.credentials` 存储为 `BAMBU_LAN_ACCESS_CODE`；它不会返回给客户端，也不会写入配置补丁。

## 测试打印

`POST /api/print-studio/print/test`（以及 `print_studio_print_test` 工具）使用 Bambu Studio 对内置的 10 x 10 x 1.2 mm 测试块进行切片，设置 H2D 双挤出机项目和 Supertack 打印板，并将切片后的 3MF 交给 Bambu Connect。Bambu Connect 要求成年人点击**发送**；macOS 上没有支持这一步最终授权的 API。`GET /api/print-studio/print/status` 和 `print_studio_progress` 通过本地 MQTT 读取进度、层数、温度、AMS 和错误。

测试块的打印时间约为六分钟。

## 网格预览

`viewer/` 模块为任意对话提供通用 3D 视口；打印只是它的调用方之一，并非其唯一用途。一个目录对应一个 Cordis 插件，因此它随此插件发布，不单独成为一个包。

STL 场景文档将几何数据与放置方式分开：

- **数据块**表示一个网格：主机读取的几何数据、规范化的 STL 字节，以及
  旋转时所围绕的中心；
- **对象**通过缩放、旋转和位置放置一个数据块；缩放和
  旋转围绕网格中心进行，位置表示底部中心的所在位置，
  因此部件放大或转动后仍位于打印板上
- **场景**包含对象，以及用于检查它们的打印空间。

同一文件打开两次会放置两个共享同一数据块的对象，因此浏览器只获取一次几何数据，每次放置变更都无需改动它。

每次变更都是一条命令（`addObject`、`removeObject`、`setTransform`、`setVisible`、`setVolume`），命令返回一个新文档，因此撤销记录是一组先前的文档。智能体通过 `mesh_open`、`mesh_transform` 和 `mesh_remove` 发出命令，并通过 `mesh_state` 读取结果；将来的操纵控件也会使用相同命令。

`GET /api/print-studio/viewer/state?sessionId=…` 返回浏览器绘制的场景，包括每个对象的放置矩阵、状态和计数。`GET /api/print-studio/viewer/model?sessionId=…&datablockId=…` 返回一个数据块的字节；这些字节打开后不会变化，并按不可变内容缓存。

`bake.js` 将场景转换为文件数据：每个可见对象生成一个已应用变换的网格。它使用与测量相同的放置计算。导出和切片可以使用这些网格，无需修改源文件。

STL 导入接受最大 20 MiB、200,000 个三角形的文件。可编辑设计使用 [Three.js 模型接口](#editable-threejs-models)。场景和数据块为八个对话保留在内存中，在插件卸载时消失。从对话中打开的 STL 使用相同的标签页类型进行文件预览。

只有 `viewport/` 导入 Three.js。两种模型都使用 `transform.js` 处理放置；`bake.js` 为导出准备已放置的 STL 几何数据。

## 客户端构建

这是携带渲染器的 Cordis 配置项，因此浏览器端经过打包，而不是以普通 JavaScript 提供：Three.js 仅供此配置项使用，不进入共享的客户端模块表。`esbuild` 和 `three` 是 `apps/rumi` 的开发依赖；`build-client.mjs` 生成 `lib/client.js`，并在旁边放置 Three 的许可证。

```sh
pnpm --filter dsh-rumi run build:print-studio-client   # or `run build`, which includes it
```

## 账户登录

设置卡片在独立的 Rumi 桌面窗口中打开 Bambu 托管的登录页。桌面适配器只接受该窗口中位于 `https://bambulab.com` 的主框架发送的登录消息。社交登录打开系统浏览器，并通过临时回环监听器返回。关闭窗口、关闭 Rumi 或达到三分钟期限时，会移除监听器和消息处理器。

窗口在用户代理中提供以空格分隔的 `BBL-Slicer/v02.08.02.61` 标记，使 Bambu 页面启用 Studio 票据回调。页面通过 `get_localhost_url` 获得 `http://localhost:<port>` 地址后才打开系统浏览器；Bambu 拒绝数字形式的回环地址。浏览器登录必须保留该返回地址。收到票据后关闭登录窗口，并将焦点移回 Rumi。

Print Studio 验证返回消息，通过 Bambu 的票据端点交换票据，并通过 `ctx.credentials` 存储凭据。桌面适配器不保留令牌或密码。浏览器卡片需要 Rumi 的桌面桥接；独立的 DSH Web 无法打开此原生登录窗口。

托管页面和票据交换已使用真实 Bambu 账户验证；Bambu 更改页面后应重新验证。本地测试覆盖用户代理格式、回调地址、票据传递、窗口清理、消息验证和票据请求。

## 源码归属

主机和客户端入口、发现逻辑、云协议、原生登录窗口、沙箱中的 Bambu preload、网格查看器和行为测试都位于此包中。`desktop/` 通过 `tsconfig.desktop.json` 单独为 Electron 编译，不由 Cordis 主机导入。Rumi 通过私有包导入组合此适配器，并打包其 preload。应用仅保留经过验证的 IPC 入口、主窗口所有权和 preload 暴露接口。`apps/rumi/tests/print-studio.spec.ts` 将包内测试纳入上游测试发现范围。可执行文件 UUID 的分配属于 Rumi 打包流程，因为它影响所有原生能力。

<a id="editable-threejs-models"></a>
## 可编辑的 Three.js 模型

将设计保存到项目的 `source/model.js`，并使用该路径调用 `viewer_load`。模块导出同步的 `build(THREE)` 函数，返回新的 `THREE.Mesh` 或 `THREE.Group`。单位为毫米，Z 轴向上。向 `viewer_load` 传入 `buildVolume` 可显示打印空间并启用适配检查；省略时保留当前打印上下文。[桌子示例](assets/example-model.js) 展示了命名部件、共享几何数据、材质和参数。

主机提供入口所在目录下 `.js` 和 `.mjs` 文件的不可变快照。相对导入必须留在该目录内，并包含扩展名；辅助函数从入口模块接收 `THREE`。不提供裸包导入、导入的资源文件或该目录外的文件。请使用专用源码目录：快照最多包含 64 个模块、2 MiB 源码和 512 个目录条目；拒绝符号链接。预览挂载期间，两次相同的源码轮询结果会发布一次更新，通常需要 2–4 秒。所有模块一起获得新 URL，包括自身未变但导入了已修改依赖的模块。

Electron 渲染进程执行模块并显示返回的对象层级。主机不执行项目 JavaScript，也不启动额外进程。模型支持静态 Mesh 和 Group 层级，最多 200,000 个可见三角形，不支持蒙皮、实例、变形目标或部分绘制范围。查看器拥有场景、灯光、相机、轨道控制和资源释放职责。构建代码必须同步执行，不访问 DOM、不创建计时器，也不产生其他副作用；它使用渲染进程的能力执行，并非运行在沙箱中。阻塞的构建会使窗口失去响应。

`viewer_transform` 在不修改源码的情况下应用统一缩放、以度为单位的 XYZ 旋转，以及以毫米为单位的底部中心位置。`viewer_camera` 根据方位角和仰角调整观看方向，不改变几何数据。两者均作用于整个已加载设计；命名部件通过源码编辑。成功重建后保留相机状态和放置方式。导入或构建失败时保留上次成功的模型，并显示错误；`mesh_state` 包含源码版本、构建错误和渲染进程报告的测量结果。测量需要预览处于挂载状态，且不能证明模型已可打印。现有的 STL 导入和场景工具仍可单独使用。

源码选择按对话保留在内存中。重启 Rumi 后，使用 `viewer_load` 重新加载。可编辑的 JavaScript 文件保留在磁盘上。

源码加载和快照是由 Print Studio 插件拥有的 Cordis effects。快照 effect 收集路由注册返回的原始 disposer。卸载会停止源码轮询，等待已接纳的加载和轮询结束，并释放路由；查看器丢弃延迟完成的导入，并释放 GPU 资源。测试使用真实 Cordis 上下文验证这些路径。
