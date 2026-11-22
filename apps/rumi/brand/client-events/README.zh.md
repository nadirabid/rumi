---
description: "保持 Rumi 的插件界面同步，无需轮询打包后的代码文件。"
kind: "package-bundle"
---

# Rumi 客户端事件

[English](README.md) | 中文

## 摘要

Rumi 会反映插件的启用、移除和显式重建通知，无需定期检查打包后的 JavaScript 文件。应用会自动包含此包。开发启动保留原有的文件监视器。此包不提供模型可见输入。

## 目录

- [使用此包](#use-this-bundle)
- [配置](#configuration)
- [实现](#implementation)
- [开发说明](#dev-note)

<a id="use-this-bundle"></a>
## 使用此包

Rumi 配置从应用自带的运行时加载 `@rumi/client-events`。其补丁禁用原有的 `client-hmr` 主机条目，并挂载 `rumi-client-events`；浏览器在 Rumi 包标识下使用原有的事件消费者。无需另行安装或设置。

插件图变更、同步配置和显式重建通知通过 `pluginEvents/follow` Remote 流传送给获授权的客户端。手动修改打包代码文件后请重启 Rumi。事件处理和无效帧报告由原有的浏览器消费者负责。

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 行为 |
|---|---|---|
| `watchBundles` | `false` | 为 true 时启用原有的文件系统监视器。 |
| `pollIntervalMs` | `500` | 以毫秒为单位的正整数监视间隔；禁用监视时不使用。 |

Rumi 主进程根据是否为打包应用设置 `RUMI_DEVELOPMENT`，随附补丁根据该值选择 `watchBundles`。已安装的应用仅传送事件；开发启动会监视代码文件。

<a id="implementation"></a>
## 实现

打包后的主机挂载上游 PluginEvents 服务，省略代码文件监视器。配置让 Typert 加载器注册上游主机描述符，浏览器在 Rumi 包标识下运行上游消费者。每条流都从按调用方 Remote 权限生成的最新插件图开始。

参见 [Rumi 构建和安装说明](../../../../RUMI.md#build)。应用构建和运行时准备会将上游提供者和消费者编译到此包中。[client-events.spec.ts](../../tests/client-events.spec.ts) 中的测试通过 Loader 挂载随附补丁，验证提供者的事件流，并检查开发监视器的释放。

<a id="dev-note"></a>
## 开发说明

协议变更须与上游客户端传输保持一致。不要为了传送插件图而恢复打包应用的定期文件轮询；注册表已经发布插件图和重建事件。
