# Print Studio

[English](README.md) | 中文

Print Studio 是 Rumi 为 3D 打印项目内置的插件，连接建模智能体、Blender、Three.js 预览和 Bambu Studio。智能体在 Blender 中编辑模型，查看器显示保存的版本，用户可以在打印板上摆放部件，再交给 Bambu Studio 切片。

## 按改动查找代码

| 功能 | 实现 | 维护参考 |
|---|---|---|
| 创建、发布与撤销模型 | [Blender 辅助工具](blender/) | [模型文件与版本](docs/models/README.zh.md) |
| 预览、指向、悬停标签与智能体的工作目标 | [查看器](viewer/) | [网格预览与选择](docs/viewer/README.zh.md) |
| 关节运动与交互式网格编辑 | [编辑控件](viewer/analog/)和[活动部件控件](viewer/movement-controls.js) | [活动部件与网格编辑控件](docs/controls/README.zh.md) |
| 几何、间隙与机械验收 | [Blender 检查](blender/validate.py)和 [Bullet 检查](bullet/) | [模型验证](docs/validation/README.zh.md) |
| 打印机设置、监控及切片软件交接 | [主机](index.js)、[设置卡片](client.js)和[原生登录](desktop/) | [打印机与打印布局](docs/printing/README.zh.md) |

要修改建模智能体获得的指导，请先看[打印项目指令](AGENTS_TEMPLATE.md)。[技能目录](skills/)保存各项任务的具体指导，包括 [Blender 建模](skills/blender-modeling/SKILL.md)和[模型区域命名](skills/name-model-regions/SKILL.md)。

## 技能提醒

主智能体继续工作时，Baseten Bison 独立审查已完成的步骤。它可以提醒智能体为本轮最终保留的模型版本更新区域表，或精简回复。主智能体负责编辑模型并答复用户。Print Studio 在所有活动轮次间一次执行一项审查，并合并排队期间的进展。每种提醒每轮最多投递一次。轮次结束时会短暂等待，然后丢弃尚未完成的审查。

无论使用哪种主模型，审查都使用已配置的 Baseten 凭据。Bison 收到用户请求与可见回复的有限摘录、任务计划、近期工具操作及结果，以及模型或区域表发生变化后的区域表状态。Shell 命令、原始工具输出、附件和模型文件保留在本地。[审查实现](skill-reminders.js)定义审查问题和提醒投递规则。[插件配置](index.js)中的 `skillReminders` 定义凭据、检查频率、阈值、超时和数据上限。

## 构建与测试

修改查看器后，运行 `pnpm --filter dsh-rumi run build:print-studio-client` 重新构建浏览器端。插件行为测试在 [tests/](tests/) 目录中。若变更影响已安装的应用，请参阅 [Rumi 构建说明](../../../../RUMI.md#build)和[安装后验证检查](../../tests/README.zh.md#validation-tool-qualification)。
