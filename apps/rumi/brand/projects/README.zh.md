# Rumi 项目

[English](README.md) | 中文

应用首页是项目画廊。每个项目对应磁盘上的一个目录，而不是会话范围的工作区。

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
- `POST /api/rumi-projects/session` — 记录项目当前使用的会话（`{ projectId, sessionId }`）。

## 职责划分

Host 端负责文件系统并返回各项目的绝对 `path`；浏览器端负责 DSH 会话（`ctx.sessions.create({ cwd })`）和导航（`ctx.uiWorkspace.openSession`）。两端不介入对方的职责，画廊不渲染自身的会话状态。

隐藏导航栏后，设置、插件和自动化不再有侧栏入口，仍可通过应用菜单和快捷键访问。

## 画廊外观

画廊采用中性背景封面、在窄窗口下缩减为两列或一列的三列网格，以及圆形 New 控件。封面显示最近成功预览的模型，适配为 480 × 320 PNG 并保存在项目目录的 `.preview.png` 中。打开的 3D 视口在场景更改稳定后截图，复用已加载的几何体和渲染器。画廊延迟加载图片，不构建网格或创建 WebGL 上下文。没有已保存预览的项目显示中性占位图，直到打开模型。模型构建失败时保留上一次成功的封面；未打开预览时修改源码不会更新封面。颜色跟随当前 DSH 主题。玻璃效果由 CSS 实现，不是原生 SwiftUI Liquid Glass。

新项目及其初始会话使用相同的 `Untitled <number>` 名称。Host 在磁盘上独占保留编号，避免并发创建和应用重启后重复使用。现有名称保持不变。

首页画廊负责项目选择。Rumi 用隐藏占用者覆盖 `conversation.hero.workspace`，并在应用自己的样式表中隐藏对话首页的工作区按钮。对话不显示原版工作区选择器。

应用顶部有独立的着色背景和单条分隔线，底层对话标题栏的边框为透明。首页显示 Projects，对话中在 Back 旁显示当前项目名称，末端显示 New。

右侧栏从项目标题栏下方开始，保证预览标签和 Close 控件可见。

顶栏在 New 前提供 Full/Regular view 和 Open/Close sidebar 控件。关闭侧栏会保留标签，Open 会恢复它们。侧栏关闭时禁用尺寸控件。侧栏 Split 控件被隐藏。
