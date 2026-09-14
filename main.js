// 卜卜宠物 · Electron 主进程
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron')
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在运行：必须用 app.exit 立即终止进程。
  // 若只用 app.quit()（异步），后续 whenReady 初始化仍会执行，
  // 导致第二个实例照常创建窗口，与第一实例重叠 → 卡死。
  console.log('[bobo] 已有卜卜在运行，退出新实例')
  app.exit(0)
}
if (gotLock) {
  app.on('second-instance', (event, argv, cwd) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}
const path = require('path')
const fs = require('fs')
const { spawn, execFileSync } = require('child_process')

const SMOKE = process.argv.includes('--smoke')
const CAPTURE = process.argv.includes('--capture')
let win = null
let positionFile = null
let audioChild = null
let audioRetries = 0

function log(...a) {
  console.log('[bobo]', ...a)
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 280,
    height: 360,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: SMOKE || CAPTURE,   // 正常启动先隐藏，等首帧皮肤加载好再显示（避免"先默认图后换图"的割裂闪变）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  const display = screen.getPrimaryDisplay()
  const wa = display.workArea
  let pos = loadPosition()
  if (!pos) {
    // 默认出现在屏幕正中（不再贴桌底）
    pos = {
      x: Math.round(wa.x + (wa.width - 280) / 2),
      y: Math.round(wa.y + (wa.height - 360) / 2)
    }
  }
  win.setPosition(pos.x, pos.y)

  win.on('closed', () => { win = null })

  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      log('SMOKE_OK window-loaded')
      setTimeout(() => { log('SMOKE_OK quitting'); app.quit() }, 5000)
    })
  }
  if (CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      // 自测保险：任何分支卡住（如 capturePage 挂起）都在 20 秒后强制退出
      setTimeout(() => { log('SELFTEST_HARD_EXIT'); app.exit(0) }, 20000)
      const save = async () => {
        try {
          const img = await win.webContents.capturePage()
          const p = '/tmp/bobo-preview.png'
          fs.writeFileSync(p, img.toPNG())
          log('CAPTURE_OK ' + p)
        } catch (e) {
          log('capture error', e.message)
        }
        app.quit()
      }
      if (process.argv.includes('--clicktest')) {
        // 模拟快速连点 4 次（走真实 mousedown/mouseup 路径）→ 触发变紫 → 稍后截图
        setTimeout(() => {
          win.focus()
          const script = '(function(){var w=document.getElementById("pet-wrap");' +
            'function c(){w.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}));' +
            'w.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0}))}' +
            'c();setTimeout(c,350);setTimeout(c,700);setTimeout(c,1050)})()'
          win.webContents.executeJavaScript(script)
          setTimeout(save, 2400)
        }, 1500)
      } else {
        setTimeout(save, 2600)
      }
    })
  }
}

function loadPosition() {
  try {
    const raw = fs.readFileSync(positionFile, 'utf8')
    const p = JSON.parse(raw)
    if (typeof p.x === 'number' && typeof p.y === 'number') return p
  } catch (e) {}
  return null
}

function savePosition() {
  if (!win || SMOKE) return
  try {
    fs.writeFileSync(positionFile, JSON.stringify(win.getPosition()))
  } catch (e) {}
}

// ---------- 宠物皮肤（内置默认双形象 + 用户自导入替换） ----------
// 出厂默认：renderer/assets/ 下的两张图（正常=橙色卜卜、生气=愤怒卜卜）。
// 用户通过右键「正常形象 / 生气表情」导入后，会覆盖默认并记住（存于 userData）。
let skinDir = null
const SKIN_META = { normal: null, angry: null }
const BUILTIN_SKIN = {
  normal: path.join(__dirname, 'renderer', 'assets', 'pet-normal.png'),
  angry: path.join(__dirname, 'renderer', 'assets', 'pet-angry.png')
}
function getSkinDir() {
  if (skinDir) return skinDir
  skinDir = path.join(app.getPath('userData'), 'pet-skins')
  fs.mkdirSync(skinDir, { recursive: true })
  return skinDir
}
function loadSkinMeta() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'pet-skin.json'), 'utf8')
    const j = JSON.parse(raw)
    if (j && (typeof j.normal === 'string' || typeof j.angry === 'string')) return j
  } catch (e) {}
  return { normal: null, angry: null }
}
const IMG_EXT = { '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.webp': 1 }
async function importSkin(kind) {
  // kind: 'normal' | 'angry'
  try {
    const parent = win && !win.isDestroyed() ? win : null
    const opts = {
      title: kind === 'angry' ? '选择一张【生气】表情图片' : '选择一张【正常】形象图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    }
    const r = parent ? await dialog.showOpenDialog(parent, opts)
                     : await dialog.showOpenDialog(opts)
    const f = (r && r.filePaths && r.filePaths[0]) || null
    if (!f) return { ok: false, src: null }
    const ext = path.extname(f).toLowerCase()
    if (!IMG_EXT[ext]) return { ok: false, src: null, reason: 'unsupported' }
    const dest = path.join(getSkinDir(), 'pet-skin-' + kind + ext)
    fs.copyFileSync(f, dest)
    SKIN_META[kind] = dest
    saveSkinMeta()
    return { ok: true, src: dest, kind: kind }
  } catch (e) {
    log('import-skin(' + kind + ') error', e.message)
    return { ok: false, src: null, kind: kind }
  }
}
function saveSkinMeta() {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'pet-skin.json'),
      JSON.stringify({ normal: SKIN_META.normal || null, angry: SKIN_META.angry || null })
    )
  } catch (e) { log('save-skin error', e.message) }
}
function ensureSkinMeta() {
  const m = loadSkinMeta()
  if (SKIN_META.normal == null) SKIN_META.normal = m.normal || null
  if (SKIN_META.angry == null) SKIN_META.angry = m.angry || null
}
ipcMain.handle('bobo:select-pet-normal', () => importSkin('normal'))
ipcMain.handle('bobo:select-pet-angry', () => importSkin('angry'))
ipcMain.handle('bobo:get-pet-skin', () => {
  ensureSkinMeta()
  return {
    normal: SKIN_META.normal || BUILTIN_SKIN.normal,
    angry: SKIN_META.angry || BUILTIN_SKIN.angry
  }
})
// 渲染进程首帧皮肤加载完成后再显示窗口（幂等，避免反复显示）
ipcMain.on('bobo:skin-rendered', () => {
  if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive()
})

// ---------- IPC ----------
ipcMain.on('bobo:quit', () => { app.quit() })
ipcMain.on('bobo:move-delta', (e, d) => {
  if (!win || !d) return
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const disp = screen.getDisplayNearestPoint({ x, y })
  const wa = disp.workArea
  let nx = Math.round(x + (d.dx || 0))
  let ny = Math.round(y + (d.dy || 0))
  // 边界保护：至少保留一部分在屏幕内，防止把卜卜拖丢
  nx = Math.max(wa.x - w + 60, Math.min(nx, wa.x + wa.width - 60))
  ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - 24))
  win.setPosition(nx, ny)
})
// ---------- 音频助手（节拍） ----------
function helperPath() {
  // 打包后二进制在 app.asar.unpacked 中（asar 归档内无法直接 exec）
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'audio-helper')
    : path.join(__dirname, 'audio-helper')
}
function startAudioHelper() {
  const helper = helperPath()
  if (!fs.existsSync(helper)) {
    log('audio-helper 不存在，跳过节拍模式')
    sendAudioState('unavailable', '未编译音频助手')
    return
  }
  audioChild = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  audioChild.on('error', (err) => {
    log('audio helper error:', err.message)
    scheduleAudioRetry()
  })
  audioChild.stdout.on('data', (buf) => {
    const text = String(buf)
    const lines = text.split('\n')
    for (const line of lines) {
      const s = line.trim()
      if (s.startsWith('E ')) {
        const v = parseFloat(s.slice(2))
        if (!isNaN(v) && win) win.webContents.send('audio:energy', Math.min(1, Math.max(0, v)))
      } else if (s === 'B') {
        if (win) win.webContents.send('audio:beat')
      } else if (s.startsWith('S ')) {
        sendAudioState('ready', s.slice(2))
      }
    }
  })
  audioChild.stderr.on('data', (buf) => log('helper stderr:', String(buf).trim().slice(0, 200)))
  audioChild.on('exit', (code) => {
    log('audio helper exited', code)
    audioChild = null
    scheduleAudioRetry()
  })
}

function sendAudioState(state, msg) {
  if (win) win.webContents.send('audio:state', { state, msg: msg || '' })
}

function scheduleAudioRetry() {
  if (audioRetries >= 3) {
    log('音频助手重试次数已达上限，节拍模式不可用')
    sendAudioState('unavailable', '节拍模式不可用（可重编译或授权屏幕录制）')
    return
  }
  audioRetries += 1
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    startAudioHelper()
  }, 4000)
}

// ---------- 启动 ----------
app.whenReady().then(() => {
  positionFile = path.join(app.getPath('userData'), 'position.json')
  ensureSkinMeta()
  createWindow()
  if (!SMOKE) {
    startAudioHelper()
  }
  // 退出时清理音频助手子进程，避免残留常驻内存
  app.on('before-quit', () => {
    savePosition()
    cleanupAudioHelper()
  })
  app.on('will-quit', () => { cleanupAudioHelper() })
})

// 在退出时终止 spawn 的 audio-helper 子进程；并兜底清理残留的孤儿进程。
// 用异步、非阻塞方式，绝不在退出同步路径里卡住进程（否则重开会冲突卡死）。
function cleanupAudioHelper() {
  try {
    if (audioChild && typeof audioChild.kill === 'function' && !audioChild.killed) {
      const c = audioChild
      // 等子进程真正退出（最多 500ms），避免 pkill 与 kill 竞争
      const onExit = () => { if (audioChild === c) audioChild = null }
      c.once('exit', onExit)
      c.kill()
      try { execFileSync('pkill', ['-f', 'app.asar.unpacked/audio-helper'], { stdio: 'ignore' }) }
      catch (e) { /* 无匹配进程，忽略 */ }
    } else {
      try { execFileSync('pkill', ['-f', 'app.asar.unpacked/audio-helper'], { stdio: 'ignore' }) }
      catch (e) { /* 无匹配进程，忽略 */ }
    }
  } catch (e) { /* 任何清理异常都不应阻塞退出 */ }
}

app.on('window-all-closed', () => { app.quit() })
