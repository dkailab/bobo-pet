// ============================================================
// 卜卜宠物 · Windows SMTC 启动器（Node 侧）
// 封装 spawn smtc-helper.exe --loop + 逐行解析 JSON + 退出清理，
// Windows 集成时可直接复用，架构与 macOS 的 audio-helper 一致。
//
// 用法：
//   const smtc = require('../scripts/smtc-helper')
//   smtc.start({
//     bin: smtc.resolveBin(app.isPackaged),
//     onFrame: (f) => { /* 每帧回调，f = {title,artist,rate,elapsed,playing,apps} 或 {title:null} */ },
//     onError: (msg) => {},
//     onExit: (code) => {},
//     intervalMs: 1500
//   })
//   smtc.stop()   // 退出清理：kill 子进程
// ============================================================
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// 解析 exe 路径：打包后与 audio-helper 一样放 app.asar.unpacked
function resolveBin(isPackaged, exeName = 'smtc-helper.exe') {
  if (isPackaged) {
    return process.platform === 'win32'
      ? path.join(process.resourcesPath, 'app.asar.unpacked', exeName)
      : path.join(process.resourcesPath, 'app.asar.unpacked', 'audio-helper')
  }
  // 开发模式：脚本所在目录的上一级（项目根）找 exe
  return path.join(__dirname, '..', exeName)
}

// 解析一行 JSON；失败返回 null
function parseLine(line) {
  const s = String(line).trim()
  if (!s) return null
  try {
    const j = JSON.parse(s)
    if (!j) return null
    return {
      title: j.title,
      artist: j.artist || '',
      rate: typeof j.rate === 'number' ? j.rate : 0,
      elapsed: typeof j.elapsed === 'number' ? j.elapsed : 0,
      playing: !!j.playing,
      apps: Array.isArray(j.apps) ? j.apps : [],
      error: j.error || null
    }
  } catch (e) {
    return null
  }
}

// 逐行消费 stdout buffer（处理半行缓冲）
function lineSplitter(emit) {
  let buf = ''
  return (chunk) => {
    buf += String(chunk)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      emit(line)
    }
  }
}

function createSession(opts = {}) {
  const {
    bin = resolveBin(false),
    onFrame = () => {},
    onError = () => {},
    onExit = () => {},
    intervalMs = 1500
  } = opts

  let child = null
  const state = { running: false }

  function start() {
    if (state.running) return state
    if (process.platform !== 'win32') {
      // 非 Windows：不报致命错误，静默跳过（调用方按 null 帧处理）
      onError('smtc-helper 仅支持 Windows')
      return state
    }
    if (!fs.existsSync(bin)) {
      onError('smtc-helper.exe 未找到: ' + bin)
      onExit(null)
      return state
    }
    state.running = true
    child = spawn(bin, ['--loop', '--interval', String(intervalMs)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.on('error', (err) => {
      state.running = false
      onError('smtc-helper spawn error: ' + err.message)
    })
    child.stdout.on('data', lineSplitter((line) => {
      const f = parseLine(line)
      if (f) onFrame(f)
    }))
    child.stderr.on('data', (buf) => {
      const t = String(buf).trim()
      if (t) onError('smtc-helper stderr: ' + t.slice(0, 200))
    })
    child.on('exit', (code) => {
      state.running = false
      child = null
      onExit(code)
    })
    return state
  }

  function stop() {
    if (child && typeof child.kill === 'function' && !child.killed) {
      child.kill()
      child = null
    }
    state.running = false
  }

  function isRunning() { return state.running }

  return { start, stop, isRunning, getChild: () => child }
}

// 便捷函数：一行启动 + 一行停止（常用场景）
class SmtcHelper {
  constructor(opts) { this.session = createSession(opts) }
  start() { return this.session.start() }
  stop() { this.session.stop() }
  isRunning() { return this.session.isRunning() }
}

module.exports = { createSession, SmtcHelper, resolveBin, parseLine, lineSplitter }