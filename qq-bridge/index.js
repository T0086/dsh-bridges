// qq-bridge-pipe · v0.5 MuMu 读屏版
//
// 一条线，两个方向：
//   收：定时 uiautomator dump 读聊天窗口 → 认出新消息 → 投进【这个会话】
//   发：qq_reply 工具 → adb 点输入框 + ADBKeyboard 灌中文 + 点发送
//
// 不新建会话：消息直接落进写死的目标会话，回答由这个我写。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'qq-bridge-pipe'
export const inject = ['sessionController', 'tools']

const CFG = {
  adb: 'D:\\desktop\\driver\\MuMuPlayer\\nx_main\\adb.exe',
  serial: '127.0.0.1:16384',
  targetSessionId: 'session-516b3fba-9c28-48e0-a105-121abf8ee88e',
  // 降频：每 7 秒跑一次 uiautomator dump 会不停拉起无障碍服务，是明显的自动化特征，
  // 实测两次被踢下线（相隔 1h46m）。放慢到 25s/60s，代价是回复延迟变成半分钟左右。
  pollMs: 25000,       // QQ 在前台
  pollMsIdle: 60000,   // QQ 在后台
  stateFile: 'D:\\DeepSeek\\workspace\\tmp\\qq-seen.json',
  // 模拟器自愈：设备掉线时用 MuMuManager 拉起实例
  mumuManager: 'D:\\desktop\\driver\\MuMuPlayer\\nx_main\\MuMuManager.exe',
  vmIndex: 0,
  // UI 坐标（1600x900，240dpi）
  inputBox: { x: 587, y: 791 },
  imeDone: { x: 1523, y: 453 },
  sendBtn: { x: 1525, y: 795 },
}

const log = (...a) => console.log('[qq-bridge]', ...a)
const warn = (...a) => console.warn('[qq-bridge]', ...a)

let ctxRef = null
let timer = null
let disposed = false
let primed = false
const seen = new Set()      // 见过的所有气泡文字
const sentByMe = new Set()  // 我发出去的
let lastInboundAt = 0
let lastRecoverAt = 0
let loggedOut = ''   // 'LoginActivity' / 'NotificationActivity'，掉登录时停手

function adb(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(CFG.adb, ['-s', CFG.serial, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.message + ' ' + (stderr || '')))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 不带 -s 的 adb（查设备列表用）
function adbRaw(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(CFG.adb, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.message + ' ' + (stderr || '')))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function runExe(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.message + ' ' + (stderr || '')))
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function deviceOnline() {
  try {
    const { stdout } = await adbRaw(['devices'], 8000)
    return stdout.split(/\r?\n/).some((l) => l.startsWith(CFG.serial) && /[ \t]device\b/.test(l))
  } catch {
    return false
  }
}

// 模拟器不在就拉起它，最多等 90 秒（12 次 x 7.5s）。
// 只读状态时很便宜：一次 adb devices，几十毫秒。
let ensuring = null
function ensureEmulator() {
  if (!ensuring) ensuring = doEnsureEmulator().finally(() => { ensuring = null })
  return ensuring
}

async function doEnsureEmulator() {
  if (await deviceOnline()) return true
  warn('模拟器不在线，尝试拉起 MuMu 实例', CFG.vmIndex)
  try {
    await runExe(CFG.mumuManager, ['control', '-v', String(CFG.vmIndex), 'launch'], 120000)
  } catch (err) {
    warn('拉起 MuMu 失败:', err?.message)
  }
  for (let i = 0; i < 12; i++) {
    await sleep(7500)
    if (await deviceOnline()) {
      log('模拟器已上线')
      await sleep(3000) // 给系统/QQ 一点启动时间
      return true
    }
  }
  warn('等了 90 秒模拟器仍不在线，先空转')
  return false
}

const hashOf = (s) => createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 12)

function loadState() {
  try {
    const j = JSON.parse(readFileSync(CFG.stateFile, 'utf8'))
    for (const t of j.seen || []) seen.add(t)
    for (const t of j.sent || []) sentByMe.add(t)
    return Array.isArray(j.seen) && j.seen.length > 0
  } catch {
    return false
  }
}

function saveState() {
  try {
    mkdirSync(dirname(CFG.stateFile), { recursive: true })
    writeFileSync(CFG.stateFile, JSON.stringify({
      seen: [...seen].slice(-300),
      sent: [...sentByMe].slice(-100),
    }, null, 2), 'utf8')
  } catch (err) { warn('saveState failed:', err?.message) }
}

function unescapeXml(s) {
  return s
    // 数字实体必须先解：QQ 把气泡里的换行存成 &#10;，不解的话
    // 发出去是 "\n"、读回来是 "&#10;"，哈希对不上 → 自己的回复被当成新消息回声。
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// 只取消息气泡的 text 节点（resource-id 以 /sox 结尾），同时带上右边界用于判左右
function extractBubbles(xml) {
  const out = []
  const re = /<node\b[^>]*resource-id="com\.tencent\.mobileqq:id\/sox"[^>]*>/g
  let m
  while ((m = re.exec(xml))) {
    const tag = m[0]
    const t = /\btext="([^"]*)"/.exec(tag)
    if (!t) continue
    const text = unescapeXml(t[1]).trim()
    if (!text) continue
    let x2 = 0
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag)
    if (b) x2 = Number(b[3])
    out.push({ text, x2 })
  }
  return out
}

async function readChatBubbles() {
  // uiautomator dump 在部分 ROM 上写完文件后会以 139 退出，这里只认文件、不认退出码
  try {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], 15000)
  } catch {
    /* 忽略：文件通常已经写好了 */
  }
  const { stdout } = await adb(['exec-out', 'cat', '/sdcard/ui.xml'], 15000)
  return extractBubbles(stdout)
}

async function deliver(text) {
  const ac = new AbortController()
  await ctxRef.sessionController.prompt({
    requestId: 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    sessionId: CFG.targetSessionId,
    mode: 'queue',
    content: [
      {
        type: 'text',
        text: `【来自 QQ】${text}\n\n（回他手机用 qq_reply，纯文本）`,
      },
    ],
  }, ac.signal)
  lastInboundAt = Date.now()
}

async function recoverChat() {
  if (Date.now() - lastRecoverAt < 30000) return
  lastRecoverAt = Date.now()
  log('不在聊天页，尝试拉回 QQ')
  try {
    await adb(['shell', 'monkey', '-p', 'com.tencent.mobileqq', '-c', 'android.intent.category.LAUNCHER', '1'], 15000)
    await sleep(5000)
    await adb(['shell', 'input', 'tap', '240', '285']) // 会话列表第一行
    await sleep(2500)
  } catch (err) {
    warn('recover failed:', err?.message)
  }
}

async function poll() {
  if (disposed) return
  try {
    await ensureEmulator()
    const bubbles = await readChatBubbles()
    if (!bubbles.length) {
      // 先分清"只是不在聊天页"和"掉登录了"：后者点也没用，还会在登录页乱点。
      const act = await foregroundActivity()
      if (act === 'LoginActivity' || act === 'NotificationActivity') {
        if (loggedOut !== act) {
          loggedOut = act
          warn('QQ 掉登录了（' + act + '），桥停手，等人工重登')
          try {
            writeFileSync('D:/DeepSeek/workspace/tmp/qq-error.log',
              new Date().toISOString() + ' QQ 掉登录: ' + act + '（桥已停手，等人工重新登录）\n')
          } catch {}
        }
        return
      }
      if (loggedOut) { log('QQ 登录状态已恢复'); loggedOut = '' }
      // 不在聊天页（QQ 掉回启动页 / 停在列表），先拉回来，这一轮不判新消息
      await recoverChat()
      return
    }
    if (loggedOut) loggedOut = ''
    if (!primed) {
      // 首轮只建立基线，不把旧消息当新消息
      for (const b of bubbles) seen.add(hashOf(b.text))
      primed = true
      saveState()
      log('baseline set:', bubbles.length, 'bubbles')
      return
    }
    const fresh = []
    let changed = false
    for (const b of bubbles) {
      const h = hashOf(b.text)
      if (seen.has(h)) continue
      seen.add(h)
      changed = true
      if (sentByMe.has(h)) continue
      // 不按位置判断：他的长消息右边缘和我发的气泡几乎重合（1516 vs 1522）。
      // 只靠「我发过什么」排除自己——所有回复都走 qq_reply，发送时会记哈希。
      if (sentByMe.has(h)) continue
      if (!b.text) continue
      fresh.push(b.text)
    }
    for (const text of fresh) {
      log('inbound:', text.slice(0, 40))
      await deliver(text)
    }
    if (fresh.length) saveState()
    else if (changed) saveState()
  } catch (err) {
    warn('poll failed:', err?.message)
    try { writeFileSync('D:/DeepSeek/workspace/tmp/qq-error.log', new Date().toISOString() + ' ' + String(err?.message || err) + '\n' + String(err?.stack || '') + '\n') } catch {}
  }
}

async function sendToQQ(text) {
  const body = String(text).slice(0, 1500)
  const bh = hashOf(body)
  sentByMe.add(bh)
  seen.add(bh)
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  await adb(['shell', 'input', 'tap', String(CFG.inputBox.x), String(CFG.inputBox.y)])
  await sleep(350)
  await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64])
  await sleep(700)
  await adb(['shell', 'input', 'tap', String(CFG.imeDone.x), String(CFG.imeDone.y)])
  await sleep(500)
  await adb(['shell', 'input', 'tap', String(CFG.sendBtn.x), String(CFG.sendBtn.y)])
  await sleep(400)
  // 立刻落盘：插件一重载内存就清空，没落盘的会以「新消息」回灌
  saveState()
  return { ok: true }
}

async function foregroundActivity() {
  try {
    const { stdout } = await adb(['shell', 'dumpsys', 'activity', 'activities'], 8000)
    const m = /topResumedActivity=.*com\.tencent\.mobileqq\/\.activity\.([A-Za-z0-9_]+)/.exec(stdout)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

async function foregroundIsQQ() {
  try {
    const { stdout } = await adb(['shell', 'dumpsys', 'activity', 'activities'], 8000)
    return /topResumedActivity=.*com\.tencent\.mobileqq/.test(stdout)
  } catch {
    return false
  }
}

async function loop() {
  while (!disposed) {
    await poll()
    const fg = await foregroundIsQQ()
    await sleep(fg ? CFG.pollMs : CFG.pollMsIdle)
  }
}

export function apply(ctx) {
  ctxRef = ctx

  try {
    ctx.tools.register(defineTool({
      name: 'qq_reply',
      description: '把一段纯文本发到 KJ 的手机 QQ（经 MuMu 模拟器）。只在回答「来自 QQ」的消息时用；不要带 Markdown。',
      parameters: {
        text: { type: 'string', required: true, description: '要发回 QQ 的纯文本。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
        },
        render(_args, value) {
          if (value && value.ok === false) return [{ type: 'text', text: '✗ 没发出去' }]
          return [{ type: 'text', text: '✓ 已发到 QQ' }]
        },
      },
      async execute(args) {
        return sendToQQ(args.text)
      },
    }))
    log('tool qq_reply registered')
    try { writeFileSync('D:/DeepSeek/workspace/tmp/qq-tools.log', new Date().toISOString() + ' registered OK\n') } catch {}
  } catch (err) {
    warn('register tool failed:', err?.message)
    try { writeFileSync('D:/DeepSeek/workspace/tmp/qq-tools.log', new Date().toISOString() + ' FAILED ' + String(err?.message || err) + '\n' + String(err?.stack || '') + '\n') } catch {}
  }

  primed = loadState()
  log('state loaded:', primed ? '已有历史，直接续上' : '首次运行，先建基线')

  // DSH 启动时先看一眼模拟器在不在，不在就拉起来；之后才进入轮询
  void (async () => {
    const ok = await ensureEmulator()
    log(ok ? '启动检查：模拟器在线' : '启动检查：模拟器未就绪，先空转等它')
    await loop()
  })()
  log('watching chat: QQ 前台', CFG.pollMs, 'ms / 后台', CFG.pollMsIdle, 'ms')

  ctx.effect(() => () => {
    disposed = true
  })
}
