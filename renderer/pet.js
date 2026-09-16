(function () {
  'use strict'
  var wrap = document.getElementById('pet-wrap')
  var petImg = document.getElementById('pet-img')
  var bubble = document.getElementById('bubble')
  var lineInput = document.getElementById('line-input')
  var menu = document.getElementById('menu')
  var statusEl = document.getElementById('status')

  var state = 'idle'
  var energy = 0
  var impulse = 0
  var t = 0
  var bubbleTimer = null

  // ---------- 气泡 ----------
  function say(text, ms) {
    bubble.textContent = text
    bubble.classList.add('show')
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(function () { bubble.classList.remove('show') }, ms || 4000)
  }
  function hideBubble() {
    clearTimeout(bubbleTimer)
    bubble.classList.remove('show')
  }

  // ---------- 自定义台词：右键“加台词”录入，存 localStorage，混入戳卜卜台词池 ----------
  var customLines = []
  try { customLines = JSON.parse(localStorage.getItem('bobo_custom_lines') || '[]') || [] } catch (e) { customLines = [] }
  var editing = false
  // 输入框当前用途：'line' 加台词 / 'rem' 加提醒 / 'todo' 加待办
  var inputMode = 'line'
  var PLACEHOLDER = { line: '写句台词，回车收下～', rem: '多久后？如 5分钟喝水 / 30分钟休息', todo: '想记下要做的事（如：写周报）' }
  function openInput(mode) {
    editing = true
    inputMode = mode
    hideBubble()
    lineInput.value = ''
    lineInput.placeholder = PLACEHOLDER[mode] || ''
    lineInput.classList.add('show')
    setTimeout(function () { lineInput.focus() }, 0)
  }
  function openLineEditor() { openInput('line') }
  function closeLineEditor(cancel) {
    editing = false
    lineInput.classList.remove('show')
    lineInput.blur()
    if (cancel) return
    var v = lineInput.value.trim()
    if (!v) return
    if (inputMode === 'line') {
      customLines.push(v)
      if (customLines.length > 30) customLines.shift()   // 最多保留 30 句
      localStorage.setItem('bobo_custom_lines', JSON.stringify(customLines))
      say('收到！以后戳我可能会说：' + v, 4200)
    } else if (inputMode === 'rem') {
      addReminder(v)
    } else if (inputMode === 'todo') {
      addTodo(v)
    }
  }
  lineInput.addEventListener('keydown', function (e) {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); closeLineEditor(false) }
    else if (e.key === 'Escape') { e.preventDefault(); closeLineEditor(true) }
  })
  lineInput.addEventListener('mousedown', function (e) { e.stopPropagation() })
  lineInput.addEventListener('contextmenu', function (e) { e.stopPropagation() })

  // ---------- 状态 ----------
  function setState(s) {
    if (s === state && s !== 'poke') return
    state = s
    wrap.classList.toggle('sleeping', s === 'sleep')
    if (s === 'sleep') say('Zzz… 不听歌了，我先睡会', 2600)
  }

  var POKE_LINES = ['嗷！别戳我！', '再戳我可就生气了🥕', '我在听歌呢', '萝卜也是要面子的，别戳啦！']
  // 变蓝后继续戳：俏皮话逐级升级，最后一句是紫葡萄警告
  var POKE_PURPLE_SEQ = [
    '别戳了，都生气了！', '再戳我要冒烟了！', '生……生气了！',
    '你是想把我戳成紫葡萄吗', '我警告你哦，手会酸的！', '真的真的别戳了啦！',
    '一颗葡萄有多甜美\n用尽了所有的 图腾和语言 描写'
  ]
  var GREET = ['你好呀，我是你的桌面小宠物！', '(跟着音乐蹦跶中~)']

  // 连点生气：2 秒内连点 3 次进入"生气"状态，停手一会恢复（不换图——形象始终是用户自己的这张）
  var purple = false
  var purpleStep = 0
  var clickLog = []
  var purpleTimer = null

  // 被戳时的 Q 弹形变
  function squash() {
    state = 'poke'
    wrap.style.transition = 'transform .12s'
    wrap.style.transform = 'translateX(-50%) scale(1.16, 0.86)'
    setTimeout(function () {
      wrap.style.transition = 'transform .3s cubic-bezier(.34,1.56,.64,1)'
      wrap.style.transform = 'translateX(-50%) scale(1,1)'
      setTimeout(function () {
        wrap.style.transition = ''
        state = 'idle'
      }, 320)
    }, 130)
  }

  function poke() {
    if (state === 'sleep') { setState('idle'); say('嗯？我醒了！', 2200); return }
    var now = Date.now()
    clickLog.push(now)
    clickLog = clickLog.filter(function (t) { return now - t < 2000 })

    // 生气状态优先：严格按升级台词走，绝不混入用户自定义台词
    if (purple) {
      var idx = Math.min(purpleStep, POKE_PURPLE_SEQ.length - 1)
      purpleStep++
      var isLast = idx === POKE_PURPLE_SEQ.length - 1
      say(POKE_PURPLE_SEQ[idx], isLast ? 5000 : 2000)
      clearTimeout(purpleTimer)
      purpleTimer = setTimeout(function () {
        purple = false
        purpleStep = 0
        applySkin('normal')
        say('呼…… 气消啦', 2000)
      }, isLast ? 5000 : 2500)
      squash()
      return
    }

    // 普通状态：2 秒内连点 3 下进入生气；普通单击才随机吐槽（自定义台词只在这里出现）
    if (clickLog.length >= 3) {
      purple = true
      purpleStep = 0
      applySkin('angry')
      say('够了够了！戳生气了！😠', 2200)
    } else {
      var pool = POKE_LINES.concat(customLines)
      say(pool[Math.floor(Math.random() * pool.length)], 2200)
    }
    squash()
  }

  // ---------- 宠物形象（用户自导入双皮肤：正常 + 生气） ----------
  // 不内置任何形象：启动取已存皮肤；生气连点切到生气图，气消切回正常图。两图可相同。
  var skinNormal = null
  var skinAngry = null
  function skinSrcToUrl(p) { return p ? 'file://' + p.replace(/#/g, '%23').replace(/ /g, '%20') : null }
  function applySkin(mode) {
    // mode: 'normal' | 'angry'
    var src = mode === 'angry' ? skinAngry : skinNormal
    if (src) petImg.src = skinSrcToUrl(src)
  }
  function changePetSkin(kind, tip) {
    hideBubble()
    var api = kind === 'angry' ? window.bobo.selectPetAngry : window.bobo.selectPetNormal
    api().then(function (r) {
      if (r && r.ok && r.src) {
        if (kind === 'angry') skinAngry = r.src
        else skinNormal = r.src
        // 更新后立即按当前情绪显示对应图
        applySkin(purple ? 'angry' : 'normal')
        say(tip + ' 已更新 🎨', 3200)
      } else {
        say('没有选择图片，保持原样～', 2400)
      }
    }).catch(function () { say('选择失败，再试一次？', 2400) })
  }
  function initSkin() {
    window.bobo.getPetSkin().then(function (r) {
      skinNormal = (r && r.normal) ? r.normal : null
      skinAngry = (r && r.angry) ? r.angry : null
      applySkin('normal')
      if (!(r && (r.normal || r.angry))) {
        // 理论上不会走到：主进程会回退内置默认。兜底提示仍可右键换图。
        say('你好呀！我是你的桌面小宠物\n右键 → 正常形象 / 生气表情，随时更换我的样子 🎨', 5200)
      }
      notifySkinShown()
    }).catch(function () { notifySkinShown() })
  }
  // 皮肤图片就绪（或超时）后再显示窗口，保证首帧即"最终皮肤"，无割裂/无空白
  function notifySkinShown() {
    var img = petImg
    function go() { try { window.bobo.skinRendered() } catch (e) {} }
    if (img && img.complete) go()
    else if (img) { img.onload = go; img.onerror = go }
    setTimeout(go, 1500)   // 兜底：图片异常也别让窗口永远不出现
  }

  // ---------- 蹦迪模式开关（记忆选择） ----------
  var danceOn = localStorage.getItem('bobo_dance') === 'on'
  function syncDanceMenu() {
    var el = menu.querySelector('[data-a="dance"]')
    if (el) el.textContent = '蹦迪模式：' + (danceOn ? '开' : '关')
  }
  function toggleDance() {
    danceOn = !danceOn
    localStorage.setItem('bobo_dance', danceOn ? 'on' : 'off')
    syncDanceMenu()
    if (danceOn) { setState('dance'); say('蹦迪模式启动！', 2200); playBgm() }
    else { setState('idle'); say('先歇会儿，不蹦了～', 2000) }
  }

  // ---------- 钢琴曲 BGM 开关（记忆选择） ----------
  var bgm = document.getElementById('bgm')
  var bgmOn = localStorage.getItem('bobo_bgm') === 'on'
  bgm.volume = 0.45
  function syncBgmMenu() {
    var el = menu.querySelector('[data-a="bgm"]')
    if (el) el.textContent = '钢琴曲：' + (bgmOn ? '开' : '关')
  }
  function playBgm() {
    if (!bgmOn) return
    var p = bgm.play()
    if (p && p.catch) p.catch(function () {})
  }
  function toggleBgm() {
    bgmOn = !bgmOn
    localStorage.setItem('bobo_bgm', bgmOn ? 'on' : 'off')
    syncBgmMenu()
    if (bgmOn) { say('钢琴曲响起～', 1800); playBgm() }
    else { bgm.pause(); say('音乐先关掉啦', 1800) }
  }

  // ---------- 音频节拍事件（蹦迪依据） ----------
  window.bobo.onAudioState(function (d) {
    if (d.state === 'ready') {
      if (statusEl.textContent && statusEl.textContent.indexOf('节拍') < 0) statusEl.textContent += ' · 节拍模式'
    }
  })
  window.bobo.onAudioEnergy(function (v) {
    energy = energy * 0.82 + v * 0.18
  })
  window.bobo.onAudioBeat(function () { impulse = 1 })

  // ---------- 动画主循环 ----------
  function frame() {
    t += 0.016
    impulse *= 0.88
    if (impulse < 0.02) impulse = 0

    if (state !== 'poke' && !dragging) {
      var base = 1 + 0.015 * Math.sin(t * 2.2)
      var ty = 0, rot = 0
      if (state === 'dance') {
        ty = Math.abs(Math.sin(t * 4.2)) * (6 + energy * 14 + impulse * 10)
        rot = Math.sin(t * 4.2 * 0.7) * 3
      } else if (state === 'idle') {
        ty = Math.sin(t * 1.6) * 2
        rot = Math.sin(t * 0.9) * 1.5
      }
      wrap.style.transform = 'translateX(-50%) translateY(' + ty.toFixed(1) + 'px) rotate(' + rot.toFixed(1) + 'deg) scale(' + base.toFixed(3) + ')'
    }

    requestAnimationFrame(frame)
  }

  // ---------- 拖拽 / 点击（整个窗口任意位置都能按住拖） ----------
  var dragging = false, dragMoved = false, sx = 0, sy = 0
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return
    if (e.target.closest && (e.target.closest('#menu') || e.target.closest('#line-input'))) return
    dragging = true; dragMoved = false
    sx = e.screenX; sy = e.screenY
    e.preventDefault()
  })
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return
    var dx = e.screenX - sx, dy = e.screenY - sy
    if (Math.abs(dx) + Math.abs(dy) > 5) {
      dragMoved = true
      sx = e.screenX; sy = e.screenY
      window.bobo.moveDelta(dx, dy)
    }
  })
  window.addEventListener('mouseup', function () {
    if (!dragging) return
    dragging = false
    if (!dragMoved) poke()
  })

  // ---------- 右键菜单 ----------
  // 输入台词中再右键：取消输入；气泡显示中再右键：取消气泡；否则才展开/收起菜单
  window.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    if (editing) { closeLineEditor(true); hideBubble(); return }
    if (bubble.classList.contains('show')) { hideBubble(); return }
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none'
  })
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#menu') && !e.target.closest('#pet-wrap')) menu.style.display = 'none'
  })
  menu.addEventListener('click', function (e) {
    var mi = e.target.closest('.mi')
    if (!mi) return
    var a = mi.dataset.a
    menu.style.display = 'none'
    if (a === 'skinNormal') changePetSkin('normal', '正常形象')
    if (a === 'skinAngry') changePetSkin('angry', '生气表情')
    if (a === 'about') say('卜卜形象版权归 STAYREAL 所有\n由品牌创建者 五月天阿信 × 不二良 共同所有\n仅供粉丝个人娱乐使用，禁止商用盈利\n右键可随时更换正常形象 / 生气表情 🥕', 6000)
    if (a === 'aiTasks') window.bobo.openAiTasks()
    if (a === 'dance') toggleDance()
    if (a === 'addline') openLineEditor()
    if (a === 'addrem') openInput('rem')
    if (a === 'todo') { openInput('todo') }
    if (a === 'todolist') { toggleTodoPanel() }
    if (a === 'pomodoro') togglePomodoro()
    if (a === 'water') toggleWater()
    if (a === 'bgm') toggleBgm()
    if (a === 'sleep') { setState(state === 'sleep' ? 'idle' : 'sleep') }
    if (a === 'quit') window.bobo.quit()
  })

  // =====================================================
  // 小工具：提醒事项 / 待办 / 番茄钟 / 喝水提醒
  // 数据都存 localStorage，随卜卜的运行而工作（需保持 App 开启）
  // =====================================================

  // ---------- 提醒事项 ⏰ ----------
  // 结构：[{ text, at, done }]，at 为触发时间戳(ms)，格式 "x分钟" / "x小时" / "x点xx分"
  var reminders = []
  try { reminders = JSON.parse(localStorage.getItem('bobo_reminders') || '[]') || [] } catch (e) { reminders = [] }
  var REM_PATTERNS = [
    { re: /^(\d+)\s*分钟$/, ms: 60000 },
    { re: /^(\d+)\s*小时$/, ms: 3600000 },
    { re: /^(\d+)\.?(\d*)\s*小时后/, parse: function (m) { return (+m[1] * 60 + +(m[2] || 0)) * 60000 } }
  ]
  function addReminder(input) {
    var text = input, at = null
    var inMatch = input.match(/^\s*(.+?)\s*(?:在|，)?\s*(\d+)\s*(分钟|小时|秒)/)
    // 拆出时间部分
    var timeStr = '', body = input
    var tm = input.match(/(\d+)\s*(分钟|小时|秒)/)
    if (tm) { timeStr = tm[0]; body = input.replace(timeStr, '').replace(/[在，,\s]+$/, '').trim() }
    if (!timeStr) {
      // 没有时间，咨询式回 5 分钟
      reminders.push({ text: input, at: Date.now() + 5 * 60000, done: false })
      saveReminders()
      say('好，5 分钟后提醒你：' + input + ' ⏰', 3600)
      return
    }
    var unitMs = { '分钟': 60000, '小时': 3600000, '秒': 1000 }[tm[2]]
    at = Date.now() + (+tm[1]) * unitMs
    if (!body) body = timeStr + ' 到啦'
    reminders.push({ text: body, at: at, done: false })
    sortReminders()
    saveReminders()
    say('记住啦：' + tm[1] + ' ' + (tm[2] === '秒' ? '秒' : tm[2]) + '后提醒你——“' + body + '” ⏰', 4200)
  }
  function sortReminders() { reminders.sort(function (a, b) { return a.at - b.at }) }
  function saveReminders() { localStorage.setItem('bobo_reminders', JSON.stringify(reminders)) }
  // 每秒检查是否有到点提醒。返回 true 表示本轮已有提醒被触发（避免一次多个）。
  function tickReminders() {
    var now = Date.now(), fired = false
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i]
      if (!r.done && r.at <= now) {
        r.done = true
        fired = true
        say('⏰ ' + r.text, 6000)
      }
    }
    if (fired) {
      reminders = reminders.filter(function (r) { return !(r.done && r.at <= Date.now() - 0) })
      saveReminders()
    }
    return fired
  }

  // ---------- 待办清单 📋 ----------
  var todos = []
  try { todos = JSON.parse(localStorage.getItem('bobo_todos') || '[]') || [] } catch (e) { todos = [] }
  var todoPanelEl = document.getElementById('todopanel')
  var tpListEl = document.getElementById('tplist')
  var tpEmptyEl = document.getElementById('tpEmpty')
  var todoRemindLeft = 30 * 60   // 距下次待办提醒的秒数
  function saveTodos() { localStorage.setItem('bobo_todos', JSON.stringify(todos)) }
  // 输入待办：纯添加
  function addTodo(v) {
    todos.push({ text: v, done: false })
    saveTodos()
    say('记下了：' + v + ' 📋\n待办还有 ' + todos.filter(function (x) { return !x.done }).length + ' 件', 4200)
  }
  function openTodosInput() { openInput('todo') }
  function todoOpenCount() { return todos.filter(function (x) { return !x.done }).length }
  // 面板：只显示未完成待办，勾选即清除
  function renderTodoPanel() {
    var open = todos.filter(function (x) { return !x.done })
    tpEmptyEl.style.display = open.length === 0 ? 'block' : 'none'
    tpListEl.innerHTML = ''
    if (open.length === 0) return
    open.forEach(function (x, i) {
      var it = document.createElement('label')
      it.className = 'tp-item'
      it.dataset.todoIndex = i
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      var span = document.createElement('span')
      span.className = 'tp-text'
      span.textContent = x.text
      it.appendChild(cb)
      it.appendChild(span)
      tpListEl.appendChild(it)
    })
  }
  // 勾选完成：直接将该待办从列表清除
  function toggleTodoCompletion(i) {
    var open = todos.filter(function (x) { return !x.done })
    var item = open[i]
    if (!item) return
    var idx = todos.indexOf(item)
    var text = item.text
    todos.splice(idx, 1)
    saveTodos()
    renderTodoPanel()
    say('搞定！「' + text + '」做完了 ✅\n还有 ' + todoOpenCount() + ' 件', 3200)
  }
  function toggleTodoPanel() {
    var show = todoPanelEl.style.display === 'none'
    if (show) { renderTodoPanel(); todoPanelEl.style.display = 'flex' }
    else todoPanelEl.style.display = 'none'
  }
  function closeTodoPanel() { todoPanelEl.style.display = 'none' }
  document.getElementById('tpClose').addEventListener('mousedown', function (e) { e.stopPropagation() })
  document.getElementById('tpClose').addEventListener('click', closeTodoPanel)
  tpListEl.addEventListener('click', function (e) {
    var it = e.target.closest('.tp-item')
    if (!it || !tpListEl.contains(e.target)) return
    toggleTodoCompletion(parseInt(it.dataset.todoIndex, 10))
  })
  todoPanelEl.addEventListener('contextmenu', function (e) { e.stopPropagation() })
  // 30 分钟待办提醒
  function todoReminder() {
    var open = todos.filter(function (x) { return !x.done })
    if (open.length === 0) return
    var msg = '主人主人，你还有事情没做呢，别忘了\n' + open.slice(0, 10)
      .map(function (x, i) { return (i + 1) + '. ' + x.text }).join('\n')
    say(msg, 7000)
  }
  function tickTodoReminder() {
    if (todoRemindLeft > 0) { todoRemindLeft--; return }
    todoRemindLeft = 30 * 60
    if (todoOpenCount() === 0) return
    todoReminder()
  }

  // ---------- 番茄钟 🍅 ----------
  var pomoOn = false
  try { pomoOn = localStorage.getItem('bobo_pomo') === 'on' } catch (e) { pomoOn = false }
  var pomoStage = 'work'   // work | break
  var pomoLeft = 25 * 60   // 秒
  var POMO_CONFIG = { work: 25 * 60, break: 5 * 60 }
  function togglePomodoro() {
    pomoOn = !pomoOn
    localStorage.setItem('bobo_pomo', pomoOn ? 'on' : 'off')
    var mi = menu.querySelector('[data-a="pomodoro"]')
    if (mi) mi.textContent = '番茄钟 🍅 : ' + (pomoOn ? '开' : '关')
    if (pomoOn) { pomoStage = 'work'; pomoLeft = POMO_CONFIG.work; say('开始一个番茄钟！25 分钟后提醒你休息 🍅', 3200) }
    else { say('番茄钟已关闭 😴', 2200) }
  }
  function tickPomodoro() {
    if (!pomoOn) return
    if (pomoLeft > 0) { pomoLeft--; return }
    if (pomoStage === 'work') { pomoStage = 'break'; pomoLeft = POMO_CONFIG.break; say('🍅 一个番茄结束，休息 5 分钟吧 ~ 喝口水', 5000) }
    else { pomoStage = 'work'; pomoLeft = POMO_CONFIG.work; say('休息结束！开始下一个番茄 🍅 加油！', 4000) }
  }
  function syncPomoMenu() {
    var mi = menu.querySelector('[data-a="pomodoro"]')
    if (mi) mi.textContent = '番茄钟 🍅 : ' + (pomoOn ? '开' : '关')
  }

  // ---------- 喝水提醒 💧 ----------
  var waterOn = false
  try { waterOn = localStorage.getItem('bobo_water') === 'on' } catch (e) { waterOn = false }
  var waterCountdown = 45 * 60  // 每 45 分钟提醒
  var WATER_LINES = ['💧 起来喝口水吧 ~', '人参要是有水，胡萝卜也一样 💧', '别盯着屏幕啦，喝口水润润嗓子']
  function toggleWater() {
    waterOn = !waterOn
    localStorage.setItem('bobo_water', waterOn ? 'on' : 'off')
    var mi = menu.querySelector('[data-a="water"]')
    if (mi) mi.textContent = '喝水提醒 💧 : ' + (waterOn ? '开' : '关')
    if (waterOn) { waterCountdown = 45 * 60; say('喝水提醒开了，每 45 分钟提醒你一次 💧', 3200) }
    else say('喝水提醒关了，记得自己多喝水哦', 2600)
  }
  function tickWater() {
    if (!waterOn) return
    waterCountdown--
    if (waterCountdown <= 0) {
      waterCountdown = 45 * 60
      say(WATER_LINES[Math.floor(Math.random() * WATER_LINES.length)], 4200)
    }
  }
  function syncWaterMenu() {
    var mi = menu.querySelector('[data-a="water"]')
    if (mi) mi.textContent = '喝水提醒 💧 : ' + (waterOn ? '开' : '关')
  }

  // 统一 1 秒调度器：提醒 / 番茄钟 / 喝水 / 待办
  setInterval(function () {
    tickReminders()
    tickPomodoro()
    tickWater()
    tickTodoReminder()
  }, 1000)

  // ---------- 启动序列：形象引导 →（没放歌时）随机问候 ----------
  function bootSequence() {
    initSkin()
  }

  // ---------- 启动 ----------
  syncDanceMenu()
  syncBgmMenu()
  syncPomoMenu()
  syncWaterMenu()
  if (danceOn) setState('dance')
  playBgm()
  setTimeout(bootSequence, 900)
  frame()
})()
