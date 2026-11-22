# 模型文件与版本

[English](README.md) | 中文

Blender 保存可编辑原件并发布供查看器使用的 USD 版本。以下 Blender 测试命令均在 Print Studio 包目录下运行。

## Blender 编辑和 USD 预览

新建模型和网格编辑通过现有 shell 工具及其权限运行本地 Blender 后台 Python 脚本。打包后的 Rumi 在 `Resources/runtime/blender` 中包含 Blender；应用更新会将该运行时替换为固定版本。`blender_status` 默认使用内置运行时，安装损坏时报告错误，不会静默回退到独立安装。显式配置的 `blenderExecutable` 优先于自动发现。开发检出可使用 `blenderHome/tools/blender/Blender.app`、`/Applications/Blender.app` 或用户的 Applications 文件夹；`blenderHome` 默认为 `DSH_RUMI_HOME` 或 `~/.rumi`。随附的 [blender-modeling 技能](../../skills/blender-modeling/SKILL.md) 定义代理工作流程；状态工具返回已安装导出辅助脚本的路径。

辅助脚本在 `models/<name>/revisions/` 下保存不可变的 `.blend`、USD 和测量版本，再原子替换 `model.usda`。脚本启动完整 Blender 进程而不打开窗口。规范 USD 以米为单位、Z 轴向上；Three.js 转换为毫米、Z 轴向上的光标、测量及高亮坐标。Blender 编辑必须考虑对象变换并将查看器坐标除以 1,000。辅助脚本在原件中保留修改器，在查看导出文件中应用修改器。导出失败保留上一份预览；不完整版本文件保留供诊断。

撤销时，`helper['restore_revision'](model_directory, revision_directory_name)` 会验证并原子恢复现有版本的完整独立 USD 字节，不重建几何或删除历史。它要求存在对应的已保存 `.blend`，返回该原件路径，并保持当前 Blender 场景不变。后续编辑前应打开该原件。恢复操作将验证标记为待处理，绝不据此认定可打印；重新加载规范预览，并在声明接受前使用显式验证工具。回归测试为 `tests/blender-restore-revision.py`，使用上述同一 Blender 命令运行。

`viewer_load` 接受项目内的独立 ASCII USD 层，限制为 64 MiB 和 200,000 个可见三角形。在资产解析前拒绝引用、外部资源、组合、变体及动画。网格和内嵌材质值必须保存在一个静态层中。查看器优先发现 `models/<name>/model.usda`，再发现旧入口，并在两次相同轮询后重新加载。不可变快照 URL 保留光标及高亮的版本身份。无效导出保留上次成功预览并报告错误。USD 元数据和几何共享一次解析的表示。后台轮询检查文件标识、大小和纳秒时间戳后复用未变化的已验证字节；验证和接受操作强制重新读取字节。这些检查不证明可打印性。

`viewer_load` 选择模型并唤醒查看器并等待与显示的 URL、修订、变换和构建体积匹配的反馈。`load.status: ready` 确认可见渲染；`design.report` 包含测量结果，`design.parameters` 包含声明的默认值和已保存的值。构建和源文件失败返回对应错误；查看器隐藏、超时、替换、取消和卸载分别返回不同的未就绪结果。超时不代表模型不受支持。确认失败时选择仍然生效；不得据此推断已回滚或可打印。在 Print Studio 配置行设置 `viewerLoadTimeoutMs`（默认 8000 毫秒，范围 1–25000 毫秒）。

## 旧模型迁移

将每个独立预览保存在 `models/<name>/model.usda`，并保留可编辑 Blender 原件。查看器通过 Three.js 渲染 USD，不执行项目代码。迁移 GLB 模型时，打开其 `.blend` 或使用辅助脚本 `import_mesh` 导入 GLB，再调用 `publish`。旧装配声明一次性转换为 USD Physics 关节，此后保留原生 USD 描述。保留原文件。旧 JavaScript 入口必须通过受限建模工具导出真实几何。不会自动迁移任何项目。

## Blender 建模辅助工具

建模技能在编辑前提供[实体构建默认规则](../../skills/blender-modeling/SKILL.md#solid-construction-defaults)：封闭实体、Exact 布尔运算、独立机械部件、受控细节处理和选择性重网格化。这些是智能体指令，不是强制执行的操作限制；几何验证仍会检查结果。

`blender_status` 还会返回 `joints`，即 `blender/rumi_joints.py` 的路径：这是一个以毫米为单位的建模工具包，提供经过清理的 Exact 布尔运算，并从 `blender/joints/*.py` 加载连接件配方。每个配方为传入的两个零件添加配合特征并返回连接记录；工具包的 `publish` 把这些记录写成 USD 装配。[`printable-joints` 技能](../../skills/printable-joints/SKILL.md)列出每个配方及其样例在真实检查中得到的结果，其 `references/` 卡片给出调用方式和选项。配方是供智能体使用的起点，而不是经过验证的库：每个配方只在默认尺寸下单独检查过，依靠摩擦、磁力或五金件固定的连接保持未验证状态，若干被形状约束的连接读出的 `excessive_penetration` 略高于默认限值。在本包目录下运行 `Blender --background --factory-startup --python-exit-code 1 --python tests/blender-joints.py` 可执行工具包回归测试。

连接件工具包提供 `outline_distances(points, outlines, batch_size=256)`，使用 Blender 内置的 NumPy 精确计算二维点到闭合轮廓的最短距离。输入和输出使用相同坐标单位，并支持零长度线段。成对计算的工作数组占用 O(batch_size²) 存储，输入和输出另占 O(points + segments)。选择边缘带时应使用它，而不是在 Python 中逐顶点遍历线段；平滑操作与发布检查均保持不变。在本包目录下运行 `blender --background --factory-startup --python-exit-code 1 --python tests/blender-outline-distances.py -- --benchmark`，可执行数值检查并获取三组合成数据计时。计时不包含启动与样例构造，也不设置 CI 实际耗时阈值。
