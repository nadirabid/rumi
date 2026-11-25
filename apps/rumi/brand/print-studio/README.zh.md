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

<a id="mechanical-badges"></a>

## 机械徽章

打开“插件”旁边的“徽章”，即可查看六种机械徽章。已获得的徽章排在前面，按所有项目中首次获得每种徽章的时间从早到晚排列。点按徽章上的项目数量，可查看获得它的项目，以及评审识别到的设计特征。每个项目的每种徽章只授予一次。同一机构后续通过运动检查时，可补充运动验证记录。

当项目的一轮对话结束并更改了已保存的模型后，Print Studio 会在后台评审其最终版本。一个项目内的对话共用一个徽章评审队列。不同项目可以同时进行徽章评审。评审使用已配置的 DeepSeek API 连接，独立于项目对话。评审会收到部件和关节说明、构造依据、相关项目片段以及已有的运动检查结果，也可以请求本地计算的截面来辨认自定义机构。徽章描述设计中的特征，实物打印表现需要另行测试。

对于以锁定姿态保存的可拆卸燕尾导轨，Print Studio 可以在垂直于拆卸方向的同一网格上比较两个部件的配合截面。吻合的燕尾形几何结构可以在运动检查通过前获得“燕尾导轨”徽章。

Rumi 将徽章、待处理评审和评审请求的私有记录保存在 `~/.rumi/print-studio/badges.sqlite` 中。设置 `DSH_RUMI_HOME` 后，数据库位于指定目录下。重新连接服务商后，可以从“徽章”页面重试失败的评审。[Print Studio 配置](index.js)提供 `badgeReview` 和 `badgeDatabase` 选项。

## 技能提醒

主智能体继续工作时，Baseten Bison 独立审查已完成的步骤。它可以提醒智能体为本轮最终保留的模型版本更新区域表，或精简回复。主智能体负责编辑模型并答复用户。同一项目内的对话共用提醒队列，该队列独立于本项目的徽章评审和其他项目。Print Studio 会合并同一轮次的排队步骤，每种提醒每轮最多投递一次。轮次结束时会短暂等待，然后丢弃该轮尚未完成的审查。

无论使用哪种主模型，审查都使用已配置的 Baseten 凭据。Bison 收到用户请求与可见回复的有限摘录、任务计划、近期工具操作及结果，以及模型或区域表发生变化后的区域表状态。Shell 命令、原始工具输出、附件和模型文件保留在本地。[审查实现](skill-reminders.js)定义审查问题和提醒投递规则。[插件配置](index.js)中的 `skillReminders` 定义凭据、检查频率、阈值、超时和数据上限。

## 构建与测试

修改查看器后，运行 `pnpm --filter dsh-rumi run build:print-studio-client` 重新构建浏览器端。插件行为测试在 [tests/](tests/) 目录中。若变更影响已安装的应用，请参阅 [Rumi 构建说明](../../../../RUMI.md#build)和[安装后验证检查](../../tests/README.zh.md#validation-tool-qualification)。

[Blender 徽章样例](tests/blender-badge-revisions.py)验证六种构造记录，并检查几何改动后旧记录是否失效。传入 `-- /absolute/scratch-directory` 可保留样例设计。然后在仓库根目录运行 `node apps/rumi/brand/print-studio/tests/qualify-badges.mjs /absolute/scratch-directory`，使用实际 DeepSeek 评审这些设计，包括在相同请求下评估无标签的折叠件和浅槽。此检查使用已配置的 DeepSeek API 账户。
