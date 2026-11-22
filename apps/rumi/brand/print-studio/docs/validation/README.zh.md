# 模型验证

[English](README.md) | 中文

发布时会报告新版本的检查结果。要排查验收问题，请按几何、打印机适配和机械检查的顺序检查已保存版本。以下测试命令均在 Print Studio 包目录下运行。

## 显式验证工具

智能体遵循[建模技能](../../skills/blender-modeling/SKILL.md#validate-a-finished-revision)。`blender_status` 依据插件的验证设置写入项目的 `.rumi/print-checks.json`。此后每次 `publish` 都在独立的 Blender 进程中检查新版本，并打印 `RUMI_CHECKS <json>`：计数非零的 Toolbox 与间隙结果、装配声明错误以及尺寸。没有该文件时，发布会打印 `status: unavailable`，失败或超时的检查绝不会报告通过。

`validation_mechanics` 接受模型 `path`，为当前版本运行缺失的装配、几何和适配阶段，任一阶段有阻断性错误时返回该阶段的结果，否则运行 Bullet；`validation_accept` 接受 `validation_mechanics` 返回的 `path` 和 `fingerprint`。

指纹涵盖模型标识、源文件字节、放置变换、打印体积和验证策略；源文件或放置变化会使先前阶段的结果失效，未变化的已完成结果会复用。结果出现在工具返回值和 `meshState.validation` 中，未解决的结果仍在查看器中可见。打开或轮询预览只恢复验证历史，不启动 Blender 或 Bullet。源文件、放置变换和打印体积的变化会使接受状态失效；显式验证工具建立当前结果。过期检查会被取消并等待退出，已完成结果会复用。为兼容现有配置，仍接受 `validationRepairAttempts`，但它不产生作用。

装配检查验证声明并持久保存必需运动意图。几何检查运行 Blender Toolbox，不检查间隙或运行 Bullet。适配检查测量间隙和配置的打印体积，并准备物理部件。没有打印体积时，打印机适配仍未检查。Bullet 要求同一版本的装配、几何和适配结果均无阻断性错误，并使用已准备的部件。主机自行运行这些阶段，因此接受不依赖智能体的 `publish` 检查。接受要求所有先前阶段完成、机械覆盖完整且通过，并保留运动意图；它不执行仿真。工具失败、取消和源文件变化均不能确立接受。修复由智能体正常编辑后重新发布，不排入新轮次。

USD 检查使用不可变源快照，在转换为毫米前应用完整父级变换。旧模型需要渲染进程导出，由 `validationTimeoutMs` 限时；发布 USD 可避免依赖已打开的查看器。工具取消和关闭会终止并等待子进程，再释放快照和路由。检查期间查看器显示当前模型。`validationStateDirectory` 默认为 Rumi 主目录的 `validation`，原子保存已接受原件及必需运动意图；状态不可用或损坏会阻止接受。不改写现有项目文件。重启后仍可恢复已接受快照；显式检查重新确立当前接受状态。

## 几何与间隙

固定版本的 GPL 许可 3D Print Toolbox 源码及许可证随包保存在 `blender/object_print3d_utils/`；`UPSTREAM.json` 标识源码修订。适配器检查流形、绕序、相交、退化、扭曲、厚度、锐边和悬垂。几何以毫米计，位置焊接容差为 0.001 mm。配置项为 `validation.minimumThicknessMm`（默认 1）、`degenerateThreshold`（0.000001，Toolbox 同时用于边长和面面积）、`overhangDegrees`（45）、`sharpDegrees`（160）及 `distortionDegrees`（45）。`validationTimeoutMs` 默认为 60000。这些是筛查阈值，并非经校准的打印公差。厚度采样和悬垂结果需要复核；有意重叠的实体也需要判断。

对于包含两个或更多部件的装配，当两个不同部件之间的表面间隙小于 `validation.minimumClearanceMm`（默认 0.2，范围 0–2，0 表示禁用）时，两种制造模式下 `insufficient_clearance` 均为错误。间隙按放置后的毫米坐标测量，覆盖除由 `fixed` 连接直接相连的部件对之外的所有部件对；重叠报告为 0，`details.pairs` 按间隙从小到大列出最多八对及其 `gapMm`。该度量为顶点到表面的距离，可能漏掉纯边到边的最小值；通过不代表装配间隙可打印。已声明的运动接受下述额外检查。不会认证装配、支撑、材料强度或最终切片就绪性。查看器仅保留输入和预览限制，以及尺寸和包络测量。

## 机械验证

模型使用 USD Physics 刚体、碰撞 API 以及固定、旋转或滑动关节。默认 prim 应用 `IsaacRobotAPI`；有序的 `isaac:physics:robotLinks` 和 `isaac:physics:robotJoints` 关系列出每个网格与关节。链接应用 `IsaacLinkAPI`，关节应用 `IsaacJointAPI`，首个链接是固定测试根部件。标准刚体关系、局部坐标系与限位定义预期运动；每个链接必须连接到根部件。旋转限位用度，滑动限位用米。关节两侧坐标系必须在保存的静止姿态相交，运动轴必须一致。有限范围定义覆盖要求，不代表存在物理限位。`rumi:control`、`rumi:manufacturingMode`、`rumi:sequences` 和 `rumi:disassembly` 保存 Rumi 特有的控件及制造要求。运动意图跨版本和重启保留；删除必需控件或缩小范围不能掩盖失败检查。参见[物理运动声明](../../skills/blender-modeling/SKILL.md#declare-physical-movement)。

Blender 未发现阻断性几何错误后，主机通过协议 2 将求值后的物理网格及装配描述传给内置 Bullet 程序。双精度 GImpact 接触保留凹几何。仅固定声明的根部件；包括保持件在内的所有其他部件均保持动态。固定、旋转和滑动连接仅描述预期相对行为，不创建理想关节。通用探测挑战禁止运动，并通过力驱动允许运动到采样姿态，同时监测每个连接及碰撞对。

保持检查测试的是脱离而非紧度：部件可在其间隙内移动，只要连接几何将其限制在 `mechanics.retentionTravelMm`（默认 2，范围 0.1–10）的枢轴位移和 `mechanics.retentionTiltDegrees`（默认 15，范围 1–45）的倾斜之内即通过。部件位移或倾斜超出任一界限，或保持探测结束时仍在向外移动，则报告 `unstable_at_rest` 和 `unretained_part`。`linearToleranceMm` 和 `angularToleranceDegrees` 仅决定被驱动关节是否到达目标（`movement_blocked`）以及 `movement_below_tolerance`。

报告记录部件、连接和序列覆盖，以及解析后的仿真策略。错误返回调用工具；不支持的物理行为及不完整覆盖保持未验证状态。程序缺失、超时或报告格式错误均不能通过。`mechanics.maxTotalSteps` 默认为 2,000,000（可配置为 1,000 至 10,000,000），超出后装配保持未验证；即使跳过完整运动，初始连接检查仍会报告缺陷。

装配最多包含 128 个物理部件和 128 个连接。将不连通实体合并为一个网格不能提供物理连接。`publish(directory, configure_robot=callback)` 向回调提供 OpenUSD stage 以编写标准声明，并在可编辑 `.blend` 中保留其 USD 层；省略回调保留已有声明。Blender 内置 OpenUSD 按照 NVIDIA 的[无 Kit 方案](https://nvidia.github.io/simready-foundation/2026.07.1/features/FET_101_ISAAC.html)直接编写 Isaac 注解，无需 Isaac Sim。注解描述预期行为，Bullet 探测网格是否实现该行为。不支持的图耦合、变形连接及数值不确定性需要复核。未声明 `rumi:disassembly` 步骤的 `separate` 装配仅由探测验证；仅当声明这些步骤（仅平移的逆向装配路径）时才检查移除路径。

`bulletExecutable` 指定开发环境的显式路径；打包后的 Rumi 使用内置程序，不搜索 `PATH`。`mechanicsTimeoutMs` 默认为 600000（十分钟），独立限制实际运行时间。`mechanics.retentionWorkers` 默认为 4（可配置为 1–4）：初始检查通过后，独立保持载荷以有界批次并行运行，各工作线程使用独立碰撞形状。运动步骤仍按顺序执行；结果保持串行顺序，且始终监测每个连接。

每个连接的独立保持载荷在保存姿态和每个范围端点姿态运行；中间运动采样和返回运动仅探测被移动的连接。对于序列，最后一个路点探测每个连接，中间路点仅探测被驱动的连接。不会根据表面对称性或距离省略探测。

原生报告上限为 8 MiB。智能体上下文和工具结果汇总通过的探测数量，并保留所有失败或不确定的探测、覆盖范围及策略；查看器状态保留完整诊断报告。

`mechanics` 策略配置密度、力及扭矩上限、持续时间、积分、接触容差、重力、摩擦和采样。默认重力为 `[0,0,-9.81]` m/s²，摩擦系数为 `0.2`，运动采样间隔为 30 度或 2 mm，`probeDurationSeconds` 为 0.25，`maxPenetrationMm` 为 0.15，拆卸路径采样间隔为 0.2 mm。这些是筛查假设，并非经过校准的打印机或材料参数。通过仅涵盖报告中的有限探测，不能保证连续无碰撞、所有同时运动组合、支撑移除、强度、磨损、变形或切片就绪。`printReady` 保持为 false。

## 验证测试

在本包目录运行 `Blender --background --factory-startup --python-exit-code 1 --python tests/blender-validation.py` 和 `tests/blender-publish-checks.py`，可执行真实 Toolbox 与发布时检查回归。会话测试覆盖力学工具运行其前置阶段、版本缓存、过期结果、取消和失败。打包还通过组合后的 Host 配置及项目隔离策略，针对真实实体和可动轮子样例调用两个工具，覆盖 Blender、Bullet、接受、缓存结果、跨项目拒绝、过期版本拒绝及单个已记录的工具调用轮次。参见[已安装验证工具验收](../../../../tests/README.zh.md#validation-tool-qualification)。
