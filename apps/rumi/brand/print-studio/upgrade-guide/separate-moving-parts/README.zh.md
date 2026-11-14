---
kind: upgrade-guide
description: 活动模型必须重新设计为分开打印，才能发布、通过验证或准备打印。
---

# 活动部件分开打印

[English](README.md) | 中文

## 变更

Rumi 要求活动实体部件分开打印后组装。现有 USD 和 Blender 原件仍可读取，以供检查和运动预览。发布和打印准备拒绝声明为 `print-in-place` 的活动组件；验证报告 `separate_printing_required`。旧的验收结果不适用于新的验证策略。缺少拆卸路径时报告 `assembly_path_required`，即使运动探测通过也不能验收。静态单部件模型不受影响。

活动组件调用 `K.robot` 和 `K.publish` 时必须显式传入 `mode='separate'`。省略该参数不再选择组装状态打印。封闭式连接示例仅供参考旧几何，不是受支持的分开打印设计。`separate` 声明本身不能证明可组装性。

## 迁移

1. 保留现有模型及修订版本。检查每个轴、铰链、滑块和限位件的插入路径及实际组装顺序；用可安装的销、盖或其他合适结构重新设计封闭连接。保留所有要求的运动和范围。
2. 更新项目 `source/` 脚本，使用 `mode='separate'` 发布。自定义 USD 回调应显式将 `rumi:manufacturingMode` 设为 `separate`。不要在未检查几何的情况下只改标签。
3. 在同一模型目录发布新修订。阅读 `RUMI_CHECKS`，解决阻断问题，通过 `K.publish(..., steps=[...])` 或 `rumi:disassembly` 为每个非根部件提供拆卸路径，再为新指纹运行 `validation_mechanics` 和 `validation_accept`。缺失或不支持的组装证据仍未验证；运动探测本身不能证明可组装性。
4. 打开 **安排打印**，检查单独摆放的各部件并保存新布局。打印前在 Bambu Studio 中检查材料、支撑和切片。
