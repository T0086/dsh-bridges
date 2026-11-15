/**
 * voice-talk —— 右 Alt「轻点一次，再按住」说话。
 *
 * 浏览器侧完成全部工作：键盘状态机、麦克风采集、WAV 编码、转写、剪贴板。
 * 转写走 Host 的 speechController（官方语音输入 Bundle 提供），不自己接 STT。
 *
 * 快捷键语义（照 Coopanion 的 tap/hold 设计，换成右 Alt）：
 *   1. 轻点一下右 Alt（< 300ms，且没有同时按别的键）——进入待命；
 *   2. 再按住右 Alt 超过 300ms——开始录音；
 *   3. 松开——停止录音、转写、复制。
 */
window.__ModuleLoader__.load({
  id: 'voice-talk',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const HOTKEY = 'AltRight'
    const TAP_MAX_MS = 300
    const TAP_GAP_MS = 400
    const SAMPLE_RATE = 16000
    const LANG = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'

    let ctxRef = null
    let altDown = false
    let tapCount = 0
    let lastUpAt = 0
    let pressAt = 0
    let mixed = false
    let holdTimer = null
    let holding = false
    let rec = null
    let toastEl = null
    // 预热：第二次按下瞬间就开流采集，300ms 判定成立后把这段缓冲并入正式录音。
    let prewarm = null
    let warmPromise = null
    let warmToken = 0

    function toast(text, kind) {
      if (!toastEl) {
        toastEl = document.createElement('div')
        toastEl.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'max-width:380px',
          'padding:10px 14px', 'border-radius:10px', 'background:#1b2440',
          'color:#e8eeff', 'font:13px/1.5 system-ui,sans-serif', 'z-index:2147483647',
          'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'white-space:pre-wrap',
        ].join(';')
        document.body.appendChild(toastEl)
      }
      toastEl.textContent = text
      toastEl.style.display = 'block'
      toastEl.style.opacity = kind === 'error' ? '0.95' : '1'
      clearTimeout(toastEl._timer)
      toastEl._timer = setTimeout(() => { toastEl.style.display = 'none' }, 4000)
    }

    function resample(input, from, to) {
      if (from === to || !input.length) return input
      const ratio = from / to
      const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
      for (let i = 0; i < out.length; i += 1) {
        const pos = i * ratio
        const i0 = Math.floor(pos)
        const i1 = Math.min(i0 + 1, input.length - 1)
        const t = pos - i0
        out[i] = input[i0] * (1 - t) + input[i1] * t
      }
      return out
    }

    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const str = (off, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)) }
      str(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      str(8, 'WAVE')
      str(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      str(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      }
      return new Uint8Array(buffer)
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    function speechService() {
      const remote = ctxRef && ctxRef.remote
      return remote && remote.speech && typeof remote.speech.transcribe === 'function' ? remote.speech : null
    }

    /**
     * SenseVoice 开了逆文本归一化，句末会自动补「。」。用户复制出去还要手动删，
     * 所以这里剥掉尾部的句号类标点；问号、感叹号保留（那是语气，不是格式）。
     * 剥空时回退原文，避免一句话只剩标点时变成空串。
     */
    function stripTrailingPeriod(value) {
      const raw = String(value || '').trim()
      const cut = raw.replace(/[。．.]+$/u, '').trim()
      return cut || raw
    }

    async function transcribe(wav) {
      const speech = speechService()
      if (!speech) {
        toast('语音服务未启用：请先安装「语音输入」Bundle', 'error')
        return null
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60000)
      try {
        const result = await speech.transcribe({ audioBase64: toBase64(wav), language: LANG }, controller.signal)
        return result && result.text ? stripTrailingPeriod(result.text) : ''
      } catch (err) {
        toast('转写失败：' + (err && err.message ? err.message : String(err)), 'error')
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    let resultEl = null
    function showResult(text) {
      if (toastEl) toastEl.style.display = 'none'
      if (!resultEl) {
        resultEl = document.createElement('div')
        resultEl.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'max-width:420px',
          'padding:12px 14px', 'border-radius:10px', 'background:#1b2440',
          'color:#e8eeff', 'font:13px/1.5 system-ui,sans-serif', 'z-index:2147483647',
          'box-shadow:0 6px 24px rgba(0,0,0,.35)',
        ].join(';')
        const body = document.createElement('div')
        body.style.cssText = 'max-height:180px;overflow:auto;white-space:pre-wrap;margin-bottom:10px'
        const bar = document.createElement('div')
        bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
        const copy = document.createElement('button')
        copy.textContent = '复制'
        copy.style.cssText = 'padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:#3f6fe0;color:#fff;cursor:pointer;font:12px system-ui'
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(resultEl._text)
            copy.textContent = '已复制'
          } catch {
            copy.textContent = '复制失败'
          }
          setTimeout(() => { copy.textContent = '复制' }, 1500)
        }
        const close = document.createElement('button')
        close.textContent = '关闭'
        close.style.cssText = 'padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#cfd7ea;cursor:pointer;font:12px system-ui'
        close.onclick = () => { resultEl.style.display = 'none' }
        bar.append(copy, close)
        resultEl.append(body, bar)
        resultEl._body = body
        document.body.appendChild(resultEl)
      }
      resultEl._text = text
      resultEl._body.textContent = text
      resultEl.style.display = 'block'
    }

    function deliver(text) {
      if (!text) { toast('没有识别到文字', 'warn'); return }
      showResult(text)
    }

    /**
     * 预热麦克风：按下瞬间就开流并开始采集，把 getUserMedia / AudioContext
     * 的启动延迟挪到 300ms 判定窗口里。判定成立后这段缓冲直接并入正式录音，
     * 所以开口第一个字不会丢。误触（提前松开）时整段丢弃。
     */
    async function warmMic() {
      if (prewarm || warmPromise) return warmPromise
      const token = ++warmToken
      warmPromise = (async () => {
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast('浏览器不支持麦克风', 'error')
            return
          }
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const AC = window.AudioContext || window.webkitAudioContext
          const audioCtx = new AC()
          if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {})
          const source = audioCtx.createMediaStreamSource(stream)
          const processor = audioCtx.createScriptProcessor(4096, 1, 1)
          const chunks = []
          processor.onaudioprocess = (e) => {
            if (prewarm) prewarm.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
          }
          source.connect(processor)
          processor.connect(audioCtx.destination)
          if (token !== warmToken) {
            // 开流期间用户已松开（误触），整段丢弃
            try { processor.disconnect() } catch {}
            try { source.disconnect() } catch {}
            try { stream.getTracks().forEach(t => t.stop()) } catch {}
            try { await audioCtx.close() } catch {}
            return
          }
          prewarm = { stream, audioCtx, source, processor, chunks, sampleRate: audioCtx.sampleRate }
        } catch (err) {
          toast('无法打开麦克风：' + (err && err.message ? err.message : String(err)), 'error')
        } finally {
          warmPromise = null
        }
      })()
      return warmPromise
    }

    function releasePrewarm() {
      warmToken += 1 // 让在途的 warmMic 完成后直接丢弃
      const w = prewarm
      prewarm = null
      if (!w) return
      try { w.processor.disconnect() } catch {}
      try { w.source.disconnect() } catch {}
      try { w.stream.getTracks().forEach(t => t.stop()) } catch {}
      try { w.audioCtx.close() } catch {}
    }

    async function startRecording() {
      if (rec) return
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast('浏览器不支持麦克风', 'error')
        return
      }
      await warmMic()
      if (!holding) { releasePrewarm(); return }
      const w = prewarm
      if (!w) return
      prewarm = null
      rec = {
        stream: w.stream,
        audioCtx: w.audioCtx,
        source: w.source,
        processor: w.processor,
        chunks: w.chunks, // 已包含按下→判定之间的缓冲
        recording: true,
        sampleRate: w.sampleRate,
      }
      rec.processor.onaudioprocess = (e) => {
        if (rec && rec.recording) rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      toast('录音中…松开右 Alt 结束')
    }

    async function stopRecording() {
      if (!rec) return
      const r = rec
      r.recording = false
      rec = null
      try { r.processor.disconnect() } catch {}
      try { r.source.disconnect() } catch {}
      try { r.stream.getTracks().forEach(t => t.stop()) } catch {}
      try { await r.audioCtx.close() } catch {}

      const total = r.chunks.reduce((n, c) => n + c.length, 0)
      if (total < 1600) { toast('录音太短，已丢弃', 'warn'); return }
      const merged = new Float32Array(total)
      let at = 0
      for (const c of r.chunks) { merged.set(c, at); at += c.length }
      const wav = encodeWav(resample(merged, r.sampleRate, SAMPLE_RATE), SAMPLE_RATE)
      toast('转写中…')
      const text = await transcribe(wav)
      if (text !== null) await deliver(text)
    }

    function othersDown(e) {
      return !!(e.ctrlKey || e.shiftKey || e.metaKey)
    }

    function onKeyDown(e) {
      if (e.code !== HOTKEY) return
      e.preventDefault()
      if (e.repeat) return
      altDown = true
      if (holdTimer || holding) return

      if (tapCount === 1 && performance.now() - lastUpAt > TAP_GAP_MS) {
        tapCount = 0
      }

      if (tapCount === 0) {
        pressAt = performance.now()
        mixed = othersDown(e)
        return
      }

      // 第二次按下：立即预热麦克风（开流采集），按住超过 TAP_MAX_MS 才正式进入录音
      void warmMic()
      holdTimer = setTimeout(() => {
        holdTimer = null
        if (!altDown) { releasePrewarm(); return }
        holding = true
        void startRecording()
      }, TAP_MAX_MS)
    }

    function onKeyUp(e) {
      if (e.code !== HOTKEY) return
      e.preventDefault()
      altDown = false

      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = null
        releasePrewarm()
        return
      }
      if (holding) {
        holding = false
        tapCount = 0
        void stopRecording()
        return
      }
      if (tapCount === 0) {
        const now = performance.now()
        if (!mixed && now - pressAt <= TAP_MAX_MS) {
          tapCount = 1
          lastUpAt = now
        } else {
          tapCount = 0
        }
      }
    }

    async function apply(ctx) {
      ctxRef = ctx
      window.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('keyup', onKeyUp, true)
      return () => {
        window.removeEventListener('keydown', onKeyDown, true)
        window.removeEventListener('keyup', onKeyUp, true)
        if (holdTimer) clearTimeout(holdTimer)
        if (rec) void stopRecording()
        releasePrewarm()
        if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl)
        toastEl = null
        ctxRef = null
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
