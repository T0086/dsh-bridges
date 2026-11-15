# voice-talk

右 Alt「轻点一次，再按住」说话：录音 → 转写 → 复制到剪贴板。

## 用法

1. 轻点一下**右 Alt**（少于 300ms，且没有同时按别的键）——进入待命；
2. 再**按住右 Alt** 超过 300ms——开始录音；
3. 松开——停止录音、转写，并把文字复制到剪贴板。

右下角会出现一条提示：录音中 / 转写中 / 已复制。

## 依赖

转写走 Host 的 `speechController`，由官方的**语音输入 Bundle**（`dsh-experimental-voice-input-bundle`）提供。没有它时插件会提示「语音服务未启用」，不会崩。

## 设计

- **键盘状态机**照 Coopanion 的 tap/hold 设计：第一次轻点、第二次按住超过 300ms 才触发；
- **麦克风预热**：第二次按下瞬间就开流采集，`getUserMedia` / `AudioContext` 的启动延迟被 300ms 判定窗口吸收；判定成立后把这段缓冲并入正式录音，开口第一个字不会丢。误触提前松开则整段丢弃并关流；
- 防误触：轻点时如果同时按着 Ctrl/Shift/Meta，不算一次 tap；
- 录音在浏览器侧用 Web Audio 采集，线性重采样到 16kHz，编码成单声道 16-bit WAV；
- 只发一次请求，超时 60 秒；
- 结果写剪贴板，不直接插入输入框（当前 client API 没有稳定的草稿写入接口）；
- 桌面 orb 走 Host 的 `/transcribe` 时，转写结果还会通过 `agent.followup()` 投递给最近活跃的根 Agent。投递必须用完整的 `{ id, role: 'user', content, source }` 消息：DSH 不会替调用方补 `role`，缺了它消息会原样进会话历史，序列化成 DeepSeek Messages 时触发 `missing field 'role'` 或 `UNSUPPORTED_CONTENT`。

## 已知限制

- 需要浏览器麦克风权限（HTTPS 或环回地址）；
- 转写语言固定为 `zh`，以后可以做成配置项；
- 只支持右 Alt；换键需要改 `client/client.js` 里的 `HOTKEY`。
