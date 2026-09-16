// 卜卜宠物 · Electron 主进程
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron')
const argv = process.argv
const SMOKE = argv.includes('--smoke')
const CAPTURE = argv.includes('--capture')
const TASKTEST = argv.includes('--tasktest')
const DEV_TEST = SMOKE || CAPTURE || TASKTEST
// 开发自测模式放过单实例锁，便于与正在运行的真实实例并存验证
const gotLock = DEV_TEST ? true : app.requestSingleInstanceLock()
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
const os = require('os')
const http = require('http')
const { spawn, execFileSync, execFile } = require('child_process')

// 开发自测(TASKTEST)用独立 userData，避免与正在运行的真实实例争抢本地存储
if (TASKTEST) {
  try { app.setPath('userData', path.join(os.tmpdir(), 'bobo-tasktest')) } catch (e) {}
}

let win = null
let positionFile = null
let audioChild = null
let audioRetries = 0

// ---------- AI 任务监控（引擎常驻运行，浮窗按需打开） ----------
let taskWin = null
let taskServer = null
let taskPort = 0
let taskDir = null
let taskTimer = null
let taskPosFile = null
let pollBusy = false
const taskMap = new Map()   // id -> task
const TASK_HTTP_PORT = 48710

// ---------- 本地工具数据读取辅助 ----------
const trailerMax = 40000          // 会话文件尾部读取字节数，避免整读超大日志
function sqliteJson(db, sql) {
  return new Promise((resolve) => {
    try {
      execFile('sqlite3', ['-json', db, sql], { timeout: 4000 }, (err, stdout) => {
        if (err) return resolve(null)
        try { resolve(JSON.parse(String(stdout))) } catch (e) { resolve(null) }
      })
    } catch (e) { resolve(null) }
  })
}
function tailRead(file, maxBytes) {
  return new Promise((resolve) => {
    let txt = ''
    try {
      const fd = fs.openSync(file, 'r')
      const st = fs.fstatSync(fd)
      const off = Math.max(0, st.size - maxBytes)
      if (off === 0) txt = fs.readFileSync(file, 'utf8')
      else {
        const buf = Buffer.alloc(st.size - off)
        fs.readSync(fd, buf, 0, buf.length, off)
        txt = buf.toString('utf8')
      }
      fs.closeSync(fd)
    } catch (e) { txt = '' }
    resolve(txt)
  })
}
function listCodexRollouts() {
  const base = path.join(os.homedir(), '.codex', 'sessions')
  const out = []
  if (!fs.existsSync(base)) return out
  ;(function walk(d) {
    let es = []
    try { es = fs.readdirSync(d) } catch (e) { return }
    for (const e of es) {
      const p = path.join(d, e)
      let st = null
      try { st = fs.statSync(p) } catch (err) { continue }
      if (st.isDirectory()) walk(p)
      else if (/^rollout-.*\.jsonl$/.test(e)) out.push({ file: p, mtime: st.mtimeMs })
    }
  })(base)
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 15)
}
function listClaudeTranscripts() {
  const base = path.join(os.homedir(), '.claude', 'projects')
  const out = []
  if (!fs.existsSync(base)) return out
  let projects = []
  try { projects = fs.readdirSync(base) } catch (e) { return out }
  for (const pr of projects) {
    const pd = path.join(base, pr)
    let files = []
    try { files = fs.readdirSync(pd) } catch (e) { continue }
    for (const f of files) {
      if (!/\.jsonl$/.test(f)) continue
      const p = path.join(pd, f)
      let st = null
      try { st = fs.statSync(p) } catch (e) { continue }
      out.push({ file: p, mtime: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 15)
}

function log(...a) {
  console.log('[bobo]', ...a)
}

// ---------- 会话 JSONL 元数据解析 ----------
function codexMeta(lines) {
  const users = [], assts = []
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    try {
      const j = JSON.parse(l)
      if (j.type === 'response_item' && j.payload && j.payload.type === 'message') {
        const text = (j.payload.content || []).map(c => (c && c.text) || '').join(' ').trim()
        if (!text) continue
        if (j.payload.role === 'user') users.push(text)
        else if (j.payload.role === 'assistant') assts.push(text)
      }
    } catch (e) { /* 单行解析失败跳过 */ }
  }
  return { title: users[users.length - 1] || '', detail: assts[assts.length - 1] || '' }
}
function claudeMeta(lines) {
  let title = '', prompt = '', lastUser = ''
  for (const raw of lines) {
    const l = raw.trim()
    if (!l) continue
    try {
      const j = JSON.parse(l)
      const t = j.type
      if (t === 'ai-title' && (j.aiTitle || j.title)) title = j.aiTitle || j.title
      else if (t === 'last-prompt' && j.lastPrompt) prompt = j.lastPrompt
      else if (t === 'user' && j.message && j.message.content) lastUser = strContent(j.message.content)
    } catch (e) { /* 跳过 */ }
  }
  return { title, prompt, lastUser }
}
function strContent(c) {
  if (Array.isArray(c)) return c.map(ci => (typeof ci === 'string' ? ci : (ci.text || ''))).join(' ').trim()
  return String(c || '')
}
function normState(s) {
  const m = { working: 'running', pending: 'queued', completed: 'done', terminated: 'done', error: 'fail', failed: 'fail', success: 'done' }
  return m[(s || '').toLowerCase()] || 'idle'
}
function shortCwd(cwd) {
  if (!cwd) return ''
  return String(cwd).replace(os.homedir(), '~')
}
function trunc(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// ---------- 各工具实时任务适配器（读本地日志/SQLite，尽力而为） ----------
async function pollWorkBuddy() {
  const db = path.join(os.homedir(), '.workbuddy', 'workbuddy.db')
  if (!fs.existsSync(db)) return []
  const sql = "SELECT id, COALESCE(NULLIF(custom_title,''), title, '') AS title, status, model, cwd, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 25"
  const rows = await sqliteJson(db, sql)
  if (!rows) return []
  const now = Date.now()
  return rows.map(r => {
    const st = normState(r.status)
    const title = (r.title || '').trim() || 'WorkBuddy 任务'
    const bits = []
    if (r.model) bits.push('模型 ' + r.model)
    if (r.cwd) bits.push(shortCwd(r.cwd))
    return { id: 'wb:' + r.id, title, state: st, progress: st === 'done' ? 100 : null, detail: bits.join(' · '), updatedAt: r.updated_at ? Number(r.updated_at) : now }
  })
}
async function pollCodex() {
  const files = listCodexRollouts()
  const now = Date.now()
  const out = []
  for (const f of files) {
    const txt = await tailRead(f.file, trailerMax)
    const { title, detail } = codexMeta(txt.split('\n'))
    const state = (now - f.mtime < 150000) ? 'running' : 'done'
    const fallback = 'Codex 会话 · ' + path.basename(f.file, '.jsonl').slice(0, 16)
    out.push({ id: 'cx:' + path.basename(f.file), title: title || fallback, state, progress: state === 'done' ? 100 : null, detail: trunc(detail, 200) || '查看 Codex 会话', updatedAt: Math.round(f.mtime) })
  }
  return out
}
async function pollClaude() {
  const files = listClaudeTranscripts()
  const now = Date.now()
  const out = []
  for (const f of files) {
    const txt = await tailRead(f.file, trailerMax)
    const { title, prompt, lastUser } = claudeMeta(txt.split('\n'))
    const state = (now - f.mtime < 150000) ? 'running' : 'done'
    out.push({ id: 'cl:' + path.basename(f.file), title: title || 'Claude 会话', state, progress: state === 'done' ? 100 : null, detail: trunc(lastUser || prompt || '查看 Claude 会话', 200), updatedAt: Math.round(f.mtime) })
  }
  return out
}
async function pollTrae() { return [] }   // 占位：TRAE 已停用监控

// ---------- 工具源注册表 + 合流 ----------
function workbuddyAppPath() {
  return fs.existsSync(path.join('/Applications', 'WorkBuddy.app')) ? 'WorkBuddy' : null
}
function toolAppName(key) {
  if (key === 'workbuddy') return workbuddyAppPath()
  return null
}
ipcMain.handle('bobo:open-tool', (e, key) => {
  const name = toolAppName(key)
  if (!name) return { ok: false, why: 'no-app' }
  try { execFile('open', ['-a', name]); return { ok: true } } catch (err) { return { ok: false, why: err.message } }
})
const TOOL_SOURCES = [
  { key: 'workbuddy', label: 'WorkBuddy', color: ['#22D3EE', 'rgba(34,211,238,.15)'],
    detect: () => fs.existsSync(path.join(os.homedir(), '.workbuddy', 'workbuddy.db')),
    poll: pollWorkBuddy, note: null },
  { key: 'codex', label: 'Codex', color: ['#A78BFA', 'rgba(167,139,250,.15)'],
    detect: () => fs.existsSync(path.join(os.homedir(), '.codex')),
    poll: pollCodex, note: null },
  { key: 'claude', label: 'Claude', color: ['#F59E0B', 'rgba(245,158,11,.15)'],
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
    poll: pollClaude, note: null }
]
async function collectToolSources() {
  const out = []
  for (const t of TOOL_SOURCES) {
    let installed = false
    try { installed = !!t.detect() } catch (e) { installed = false }
    // 装了对应工具但没有可读会话日志时，视为未安装而不显示 tab
    if (installed && t.key === 'codex' && listCodexRollouts().length === 0) installed = false
    if (installed && t.key === 'claude' && listClaudeTranscripts().length === 0) installed = false
    let tasks = []
    if (installed) { try { tasks = await t.poll() || [] } catch (e) { tasks = [] } }
    out.push({ key: t.key, label: t.label, installed, appName: toolAppName(t.key), color: t.color, note: t.note || null, tasks })
  }
  // 「推送接入」源：~/bobo-tasks 文件 + 本地 HTTP
  const push = Array.from(taskMap.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  out.push({ key: 'push', label: '推送接入', installed: true, appName: null, color: ['#FBBF24', 'rgba(251,191,36,.15)'], note: null, tasks: push })
  return out
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

// ---------- AI 任务监控：引擎 + 浮窗 ----------
// 数据源（通用、不绑定任何一家私有协议）：
//   1) 监听统一任务目录 ~/bobo-tasks/ 下的 *.json，任何 AI 工具/脚本把任务状态写成 JSON 即被拾取
//   2) 本地 HTTP 服务 127.0.0.1:<TASK_HTTP_PORT>，POST /tasks 实时推送 / DELETE /tasks/{id} 删除
// 任一接入方式都实时刷新悬浮监控浮窗；浮窗高度随任务数量动态伸缩，多任务以卡片分开渲染、不堆叠。
function getTaskDir() {
  if (taskDir) return taskDir
  taskDir = path.join(os.homedir(), 'bobo-tasks')
  try { fs.mkdirSync(taskDir, { recursive: true }) } catch (e) {}
  return taskDir
}

function scanTaskFiles() {
  const dir = getTaskDir()
  let files = []
  try { files = fs.readdirSync(dir) } catch (e) { return }
  const found = new Set()
  for (const f of files) {
    if (!/\.json$/i.test(f) || f.endsWith('.seeded')) continue
    const p = path.join(dir, f)
    found.add(f)
    let raw
    try { raw = fs.readFileSync(p, 'utf8') } catch (e) { continue }
    try {
      const t = JSON.parse(String(raw).replace(/^\uFEFF/, ''))
      if (!t || typeof t.id !== 'string' || !t.id) continue
      t.file = f
      taskMap.set(t.id, t)
    } catch (e) { /* 正在写入/不完整文件：跳过本帧 */ }
  }
  for (const [id, t] of taskMap) {
    if (t.file && !found.has(t.file)) taskMap.delete(id)
  }
}

async function broadcastTasks() {
  if (!taskWin || taskWin.isDestroyed() || !taskWin.isVisible()) return
  let sources = []
  try { sources = await collectToolSources() } catch (e) { sources = [] }
  let total = 0, running = 0, done = 0, failed = 0
  for (const s of sources) for (const t of s.tasks) {
    total++
    if (t.state === 'running') running++
    else if (t.state === 'done') done++
    else if (t.state === 'fail' || t.state === 'error') failed++
  }
  taskWin.webContents.send('tasks:update', { sources, meta: { total, running, done, failed } })
}

async function pollTasks() {
  if (pollBusy) return
  pollBusy = true
  try {
    scanTaskFiles()
    await broadcastTasks()
  } finally { pollBusy = false }
}

function upsertTask(t) {
  t.updatedAt = Date.now()
  taskMap.set(t.id, t)
  const safe = String(t.id).replace(/[^A-Za-z0-9._-]/g, '_') || 'task'
  try { fs.writeFileSync(path.join(getTaskDir(), safe + '.json'), JSON.stringify(t, null, 2)) } catch (e) {}
  broadcastTasks()
}

function removeTask(id) {
  taskMap.delete(id)
  const dir = getTaskDir()
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(f) || f.endsWith('.seeded')) continue
      let raw = ''
      try { raw = fs.readFileSync(path.join(dir, f), 'utf8') } catch (e) { continue }
      try {
        const j = JSON.parse(String(raw).replace(/^\uFEFF/, ''))
        if (j && j.id === id) { fs.unlinkSync(path.join(dir, f)); break }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {}
  broadcastTasks()
}

function handleTaskRequest(req, res) {
  const u = req.url || '/'
  const pathname = u.split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('卜卜 AI 任务监控 · 127.0.0.1:' + taskPort + '\n任务数: ' + taskMap.size + '\nPOST /tasks 推送任务 · GET /tasks 查询 · DELETE /tasks/{id} 移除\n示例: curl -X POST -H "Content-Type: application/json" -d \'{"id":"t1","title":"hi","state":"running"}\' http://127.0.0.1:' + taskPort + '/tasks')
    return
  }
  if (req.method === 'GET' && pathname === '/tasks') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(Array.from(taskMap.values())))
    return
  }
  if (req.method === 'POST' && /^\/tasks(\/|$)/.test(pathname)) {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy() })
    req.on('end', () => {
      try {
        const j = JSON.parse(body)
        const task = j && j.task ? j.task : j
        if (task && typeof task.id === 'string' && task.id) {
          if (task.state === 'removed' || task.deleted) removeTask(task.id)
          else upsertTask(task)
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, count: taskMap.size }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'bad-json' }))
      }
    })
    return
  }
  if (req.method === 'DELETE' && /^\/tasks\//.test(pathname)) {
    removeTask(decodeURIComponent(pathname.slice(7)))
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, removed: true }))
    return
  }
  res.writeHead(404); res.end()
}

function startTaskMonitor() {
  // 首次运行写入两条示例任务，打开浮窗即可看到动态列表与完整数据链路（可直接删除 ~/bobo-tasks 下文件）
  try {
    const flag = path.join(getTaskDir(), '.seeded')
    if (!fs.existsSync(flag)) {
      const samples = [
        { id: 'demo-1', source: 'TRAE', title: '整理登录页权限重构', state: 'running', progress: 64, detail: '正在抽取统一的鉴权中间件…', updatedAt: Date.now() - 60000 },
        { id: 'demo-2', source: 'Codex', title: '修复构建脚本 lipo 合并', state: 'running', progress: 32, detail: '重新编译 arm64 helper…', updatedAt: Date.now() - 20000 }
      ]
      for (const t of samples) fs.writeFileSync(path.join(getTaskDir(), t.id + '.json'), JSON.stringify(t, null, 2))
      fs.writeFileSync(flag, '1')
    }
  } catch (e) {}
  pollTasks()
  taskTimer = setInterval(pollTasks, 900)

  try {
    taskServer = http.createServer(handleTaskRequest)
    taskServer.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && taskPort !== 0) {
        taskServer.listen(0, '127.0.0.1', () => { taskPort = taskServer.address().port })
      }
    })
    taskServer.listen(TASK_HTTP_PORT, '127.0.0.1', () => { taskPort = taskServer.address().port })
    log('AI任务监控端口 http://127.0.0.1:' + taskPort)
  } catch (e) {
    log('start task http server error', e.message)
  }
}

function cleanupTaskMonitor() {
  if (taskTimer) { clearInterval(taskTimer); taskTimer = null }
  if (taskServer) { try { taskServer.close() } catch (e) {} taskServer = null }
  if (taskWin && !taskWin.isDestroyed()) { try { taskWin.destroy() } catch (e) {} taskWin = null }
}

function loadTaskPosition() {
  try {
    const p = JSON.parse(fs.readFileSync(taskPosFile, 'utf8'))
    if (typeof p.x === 'number' && typeof p.y === 'number') return p
  } catch (e) {}
  return null
}
function saveTaskPosition() {
  if (!taskWin || taskWin.isDestroyed() || SMOKE || CAPTURE) return
  try { fs.writeFileSync(taskPosFile, JSON.stringify(taskWin.getPosition())) } catch (e) {}
}

function createTaskWindow() {
  // 已存在：可见则隐藏、隐藏则显示前置（即"右键菜单是开关"）
  if (taskWin && !taskWin.isDestroyed()) {
    if (taskWin.isVisible()) taskWin.hide()
    else { taskWin.show(); taskWin.focus(); broadcastTasks() }
    return
  }
  taskWin = new BrowserWindow({
    width: 360,
    height: 260,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  taskWin.setAlwaysOnTop(true, 'floating')
  taskWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  taskWin.loadFile(path.join(__dirname, 'renderer', 'tasks.html'))
  const wa = screen.getPrimaryDisplay().workArea
  let pos = loadTaskPosition()
  if (!pos) pos = { x: wa.x + wa.width - 380, y: wa.y + 40 }
  taskWin.setPosition(pos.x, pos.y)
  taskWin.webContents.once('did-finish-load', broadcastTasks)
  taskWin.once('ready-to-show', () => { taskWin.showInactive(); setTimeout(broadcastTasks, 150) })
  taskWin.on('moved', saveTaskPosition)
  taskWin.on('closed', () => { taskWin = null })
}

ipcMain.on('bobo:open-ai-tasks', createTaskWindow)
ipcMain.handle('bobo:ai-tasks-info', () => ({
  port: taskPort,
  dir: getTaskDir(),
  sample: JSON.stringify({ id: 't-demo', source: 'TRAE', title: '示例任务', state: 'running', progress: 50 })
}))
ipcMain.on('tasks:resize', (e, d) => {
  if (!taskWin || taskWin.isDestroyed() || !taskWin.isVisible()) return
  const w = Math.max(280, Math.min(430, Math.round(d.width || 360)))
  const h = Math.max(180, Math.min(640, Math.round(d.height || 260)))
  const [curW, curH] = taskWin.getSize()
  if (Math.abs(curW - w) > 2 || Math.abs(curH - h) > 2) taskWin.setSize(w, h)
})

// ---------- 启动 ----------
app.whenReady().then(() => {
  positionFile = path.join(app.getPath('userData'), 'position.json')
  taskPosFile = path.join(app.getPath('userData'), 'ai-tasks-position.json')
  ensureSkinMeta()
  createWindow()
  if (TASKTEST) {
    setTimeout(() => { log('TASKTEST_HARD_EXIT'); app.exit(0) }, 20000)
    const pre = Date.now() - 120000
    upsertTask({ id: 'f-a', source: 'TRAE', title: '重构鉴权中间件', state: 'running', progress: 30, detail: '正在抽取统一登录拦截…', updatedAt: pre })
    createTaskWindow()
    setTimeout(() => upsertTask({ id: 'f-b', source: 'Codex', title: '修复构建脚本 lipo 合并', state: 'running', progress: 62, detail: '重新编译 arm64 helper 二进制…', updatedAt: Date.now() - 5000 }), 400)
    setTimeout(() => upsertTask({ id: 'f-c', source: 'WorkBuddy', title: '整理会议纪要', state: 'done', progress: 100, detail: '已完成摘要与待办提取', updatedAt: Date.now() - 3000 }), 650)
    var snap = () => setTimeout(() => {
      taskWin.webContents.capturePage().then((img) => {
        fs.writeFileSync('/tmp/bobo-tasks-preview.png', img.toPNG())
        log('TASKTEST_OK /tmp/bobo-tasks-preview.png')
        app.exit(0)
      }).catch(() => app.exit(0))
    }, 1300)
    if (taskWin && taskWin.webContents.isLoading()) taskWin.webContents.once('did-finish-load', snap)
    else setTimeout(snap, 500)
  }
  if (!SMOKE && !TASKTEST) {
    startAudioHelper()
  }
  if (!SMOKE) {
    startTaskMonitor()
  }
  // 退出时清理音频助手子进程，避免残留常驻内存
  app.on('before-quit', () => {
    savePosition()
    cleanupAudioHelper()
    cleanupTaskMonitor()
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
