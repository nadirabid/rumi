# Live Voice

[English](README.md) | 中文

Rumi 的全双工语音功能：GPT-Live 负责听和说，Harness 执行它委派的工作。

该软件包由 Rumi 维护，名称为 `@rumi/live-voice`。`src/` 管理 OpenAI 连接和 Harness 委派；`client/` 管理麦克风采集、播放和输入框旁的控件。Rumi 在默认配置中包含此 Bundle。

## 配置

在 **插件 → Live Voice** 中设置密钥。主机通过 `ctx.credentials` 保存密钥；设置响应仅包含是否已配置、掩码提示和存储位置。凭据服务的解析结果优先于显式配置和指定的旧密钥文件（内置配置使用 `~/.rumi/live-voice.key`）。启动环境是最后的回退来源。保存替代密钥不会改写旧文件。

## 会话生命周期

语音控件固定在发送按钮旁，麦克风静音控件出现在它的左侧。语音启用时，图标的前景色与背景色互换；动画也会指示活动状态。

连接期间，控件显示虚线加载环，并可再次点击取消。主机报告就绪且本地音频设置完成后，才会显示启用配色和静音控件。

关闭语音会丢弃排队的委派并立即停止本地采集。已提交给 Harness 的工作可以继续完成；插件释放会等待其会话写入和传输关闭。正在启动的连接不能在插件释放后发布会话，同一对话的重叠启动请求会被拒绝。

委派保留缓冲的完整请求，包括单词指令和中文指令。转录缓冲区最多保留 4,000 个字符。重复的委派 ID 会被忽略；新委派可以使用相同的话语。

## 上下文

输入框提供所属会话的 ID。连接前，主机解析该会话并加入其规范对话内容：用户文本、助手文本和保留的压缩摘要。`contextMaxCharacters` 默认保留最近 16,000 个字符（可配置为 1 到 64,000）；省略的早期文本会被标记。系统提示、推理块、工具载荷和非文本附件不包含在内。源文本可从会话日志重建。

同一会话中新提交的消息会作为静默上下文转发，包括连接握手期间收到的消息。其他会话的更新会被忽略。输入框切换到另一会话时，会停止语音并重置控件。语音无法直接查看预览器或项目文件；它会将这些问题委派给 Harness。

主机管理委派 ID 和通道选择。其他插件通过 `ctx.liveVoice` 提供启动指令：

```js
ctx.inject(['liveVoice'], (scoped) => {
  scoped.effect(() => scoped.liveVoice.register({
    id: 'project',
    instructions: sessionId => readProjectInstructions(sessionId),
  }), 'context')
})
```

各项贡献在会话启动时按 `order` 组合。抛出异常的贡献会被记录并跳过。`@rumi/projects` 通过此方式提供项目的 `AGENTS.md`。对此文件的修改在下一次语音会话中生效。

Harness 轮次运行期间，主机跟踪会话事件，每隔几秒最多发送一次静默的 `thinking` 说明。完成的结果作为对应委派的 commentary 返回。

## 验证

运行 `pnpm exec vitest run --config apps/rumi/vitest.voice.config.ts`。此配置将直接发布的 JavaScript 导入解析到工作区源码。测试使用本地 WebSocket 服务器和可控的浏览器音频 Promise，不会联系 OpenAI 或采集麦克风音频。
