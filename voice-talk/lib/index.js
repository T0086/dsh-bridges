// voice-talk host 侧：
// 1) 给桌面 orb 提供本地 /transcribe；
// 2) 直接加载 SenseVoice（sherpa-onnx-node），不依赖语音 Bundle 的 speechToText 服务——
//    那组行被更高优先级的 preset 覆盖，启用不了，所以这里自带识别器。
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = []

const require = createRequire(import.meta.url)

function home() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function modelDir() {
  return join(home(), 'speech-to-text', 'sensevoice')
}

function loadSherpa() {
  const candidates = [
    join(home(), 'profiles', 'desktop', 'node_modules', 'sherpa-onnx-node'),
    'sherpa-onnx-node',
  ]
  let last = null
  for (const c of candidates) {
    try { return require(c) } catch (err) { last = err }
  }
  throw last || new Error('sherpa-onnx-node not found')
}

let recognizerPromise = null
function recognizer() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      const { OfflineRecognizer } = loadSherpa()
      const dir = modelDir()
      return OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: join(dir, 'model.int8.onnx'),
            language: 'zh',
            useInverseTextNormalization: 1,
          },
          tokens: join(dir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      })
    })().catch((err) => {
      recognizerPromise = null
      throw err
    })
  }
  return recognizerPromise
}

/** 从 WAV 里取 PCM16，转成 sherpa 要的 Float32。 */
function wavToSamples(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV')
  let at = 12
  let rate = 16000
  let bits = 16
  let channels = 1
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      const n = Math.min(size, buf.length - body)
      const frames = Math.floor(n / (bits / 8) / channels)
      const out = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) {
        out[i] = buf.readInt16LE(body + i * 2) / 32768
      }
      return { samples: out, rate }
    }
    at = body + size + (size % 2)
  }
  throw new Error('WAV data chunk missing')
}

/**
 * SenseVoice 的逆文本归一化会在句末补「。」。这里剥掉尾部句号类标点，
 * 问号/感叹号保留；剥空时回退原文。与 client/client.js 的同名函数保持一致。
 */
function stripTrailingPeriod(value) {
  const raw = String(value || '').trim()
  const cut = raw.replace(/[。．.]+$/u, '').trim()
  return cut || raw
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  /**
   * 构造 DSH 认可的完整 user 消息。
   *
   * 不能直接把 `{ content, source }` 交给 `agent.followup()`：DSH 的 inbox 和
   * 会话历史只校验结构、不补字段，缺 `role` 的消息会原样进入 surface，
   * 序列化成 DeepSeek Messages 时变成 `{ content: [...] }`（JSON 丢掉 undefined 的
   * role），服务端反序列化报 `messages[N]: missing field 'role'`；同时它不被认作
   * user，接下来的 in-history system 更新会报 UNSUPPORTED_CONTENT。
   * id 也必须是稳定的唯一标识，inbox 用它判重。
   */
  function createUserMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  /** 把转写结果直接投给最近活跃的根 Agent；失败就只返回文本，由 orb 显示。 */
  function deliverToAgent(text) {
    try {
      const agents = ctx.get('agents')
      if (!agents) return false
      const list = typeof agents.roots === 'function' ? agents.roots() : agents.list()
      const agent = Array.isArray(list) && list.length ? list[list.length - 1] : null
      if (!agent || typeof agent.followup !== 'function') return false
      agent.followup(createUserMessage(text))
      return true
    } catch {
      return false
    }
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/transcribe') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let audioBase64 = ''
    try { audioBase64 = String((JSON.parse(body) || {}).audioBase64 || '') } catch {}
    if (!audioBase64) return json(res, 400, { error: 'empty audio' })

    try {
      const wav = Buffer.from(audioBase64, 'base64')
      const { samples, rate } = wavToSamples(wav)
      if (rate !== 16000) return json(res, 400, { error: 'expected 16k WAV, got ' + rate })

      // 静音/底噪直接返回空，避免 SenseVoice 对空音频输出「没。」这类噪声。
      let energy = 0
      for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i]
      const rms = Math.sqrt(energy / Math.max(1, samples.length))
      if (rms < 0.005) return json(res, 200, { text: '' })

      const rec = await recognizer()
      const stream = rec.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples })
      const result = await rec.decodeAsync(stream)
      const text = stripTrailingPeriod((result && result.text) || '')
      const delivered = text ? deliverToAgent(text) : false
      return json(res, 200, { text, delivered })
    } catch (err) {
      return json(res, 500, { error: err && err.message ? err.message : String(err) })
    }
  })

  server.listen(0, '127.0.0.1', () => {
    try {
      const dir = join(home(), 'voice-talk')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'port.txt'), String(server.address().port))
    } catch {}
  })

  return () => { try { server.close() } catch {} }
}
