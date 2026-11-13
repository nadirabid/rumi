# Rumi 项目

[English](README.md) | 中文

应用首页是项目画廊。每个项目对应磁盘上的一个目录，而不是会话范围的工作区。

当前项目模板也会注册到后端系统提示词中，因此现有项目无需重写文件即可获得强制性的[对话范围要求](../../../../RUMI.md#conversation-scope)。

## 项目是什么

```text
~/.rumi/workspace/<project-id>/
  project.json   # id, name, session ids, timestamps
  artifacts/     # outputs to keep: STL, slices, images, documents
  source/        # editable source used to regenerate them
  references/    # imported assets and reference material
```

项目 id 不可变，也是目录名称；用户看到的名称保存在 `project.json` 中，因此重命名不会移动文件。打开项目会启动或复用一个以项目根目录为工作目录的 DSH 会话，并将会话 id 记录到 `project.json`。内部 DSH 工作区保留由目录派生的唯一名称，因此多个项目可以使用相同的显示名称。

## 界面

- `main` 面板 `projects` — 项目画廊。在创建第一个项目之前为空。
- `shell.leading` — 窗口顶部控件：浏览时显示 **New**，打开项目后显示项目名称和 **Close**。框架仅在导航栏完全隐藏时挂载该位置，因此插件在启动时折叠导航栏。
- 创建或打开项目时，会在对话旁打开 **3D 预览**标签页，即使尚无模型。
- 关闭项目通过 `ctx.layout.selectPanel('projects')` 返回画廊，不会结束会话；正在运行的轮次或未发送的草稿会保留。

## 路由

- `GET /api/rumi-projects` — 列出所有可读项目，最近更新的在前。
- `POST /api/rumi-projects` — 创建项目（`{ name }`）。
- `DELETE /api/rumi-projects?projectId=<id>` — 删除项目及其目录；成功返回 `204`，项目不存在返回 `404`。
- `POST /api/rumi-projects/session` — 记录项目当前使用的会话（`{ projectId, sessionId }`）。

## 职责划分

Host 端负责文件系统并返回各项目的绝对 `path`；浏览器端负责 DSH 会话（`ctx.sessions.create({ cwd })`）和导航（`ctx.uiWorkspace.openSession`）。两端不介入对方的职责，画廊不渲染自身的会话状态。

隐藏导航栏后，设置、插件和自动化不再有侧栏入口，仍可通过应用菜单和快捷键访问。

## 项目隔离

代理的文件操作仅限于 `project.json` 为其会话登记的目录。规范路径检查同时覆盖读取和写入，包括绝对路径、父目录跳转及已有符号链接。Shell 和搜索子进程通过 macOS Seatbelt 执行，子进程继承相同限制。已保存的完全访问模式和提权请求无法扩大权限。拒绝信息作为工具结果记录在会话中。

已安装的应用资源、系统可执行文件和共享依赖运行时是只读例外，不用于存储项目数据。`rumi-project-scope` 提供者接受绝对路径配置 `workspaceRoot` 和 `runtimeRoots`。运行时授权目录只能包含可信的运行时文件。项目指令仅从所属根目录的 `AGENTS.md` 读取，并通过已记录的运行时上下文提供；禁用祖先、全局和嵌套指令发现。`instructionMaxBytes` 默认为 65,536，接受 1–1,048,576 字节；过大的指令会失败，而不是被截断。画廊和会话持久化仍是代理工具范围之外的可信应用操作。两个显式 Print Studio 验证工具 `validation_mechanics` 和 `validation_accept` 允许已登记的项目会话使用；模型路径参数仍限于所属项目。验证器使用不可变项目快照以及应用管理的临时和接受状态存储。此策略不会隔离 Codex 或其他在 Rumi 之外运行的应用。

命令使用项目内的 `.rumi/tmp` 保存临时文件，并将项目目录设为 `HOME`。命令可以访问网络，因此可以用 `curl` 把图片下载到 `references/`；Apple events、硬链接创建、符号链接创建以及目录删除或重命名仍被禁止。模型可见的 `web_search` 与 `web_fetch` 工具已向已注册的项目会话开放：它们不经过项目沙盒的主机网络，只通过 Web 服务访问公共 HTTP(S) 端点，且 `web_fetch` 仍拒绝二进制和图片内容。这些限制防止子进程利用其他服务或替换目录身份绕过宿主路径检查。项目内的文件仍可创建、编辑和删除。`todo_write` 工具在调用方的项目会话中记录任务进度。未经项目访问审查的工具默认拒绝执行。此提供者需要 macOS；不支持的平台在加载时失败。

升级时，Rumi 将其初始化的配置策略迁移至 `workspace-write`，同时保留无关的自定义配置。已有项目文件和会话日志无需迁移。请先将所需素材导入当前项目的 `references/` 目录，再让代理使用；引用其他项目的路径会被拒绝。可执行的 JavaScript 模型预览被禁用；请使用受限建模工具导出 GLB。自定义工具必须经过审查并加入允许列表才能执行。

## 画廊外观

画廊采用中性背景封面、在窄窗口下缩减为两列或一列的三列网格，以及样式一致的圆形玻璃 Plugins 和 New 控件。拼图形 Plugins 控件紧邻 New 左侧，可从画廊或已打开的项目进入原有插件页面。封面显示最近成功预览的模型，适配为 480 × 320 PNG 并保存在项目目录的 `.preview.png` 中。打开的 3D 视口在场景更改稳定后截图，复用已加载的几何体和渲染器。画廊延迟加载图片，不构建网格或创建 WebGL 上下文。没有已保存预览的项目显示中性占位图，直到打开模型。模型构建失败时保留上一次成功的封面；未打开预览时修改源码不会更新封面。颜色跟随当前 DSH 主题。玻璃效果由 CSS 实现，不是原生 SwiftUI Liquid Glass。

新项目及其初始会话使用相同的 `Untitled <number>` 名称。Host 在磁盘上独占保留编号，避免并发创建和应用重启后重复使用。现有名称保持不变。

首页画廊负责项目选择。Rumi 用隐藏占用者覆盖 `conversation.hero.workspace`，并在应用自己的样式表中隐藏对话首页的工作区按钮。对话不显示原版工作区选择器。

应用顶部有独立的着色背景和单条分隔线，底层对话标题栏的边框为透明。首页显示 Projects，对话中在 Back 旁显示当前项目名称，末端显示 New。

右侧栏从项目标题栏下方开始，保证预览标签和 Close 控件可见。

顶栏在 Plugins 和 New 前提供 Full/Regular view 和 Open/Close sidebar 控件。关闭侧栏会保留标签，Open 会恢复它们。侧栏关闭时禁用尺寸控件。侧栏 Split 控件被隐藏。

右键点击项目会打开玻璃菜单，包含“打开”和“删除”。删除前会先确认：提示框显示项目封面和名称，并说明无法恢复；默认选项是“取消”。确认后项目目录会从磁盘移除。浏览器没有可用的 canvas 时，玻璃效果退回为普通模糊。
