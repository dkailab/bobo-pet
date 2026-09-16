(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var grid = $('grid')
  var empty = $('empty')
  var clock = $('clock')

  var cards = {}   // id -> card DOM (len 为 0 则代表已移除/不存在)

  // 各 AI 工具来源的徽标配色
  var SRC_COLORS = {
    TRAE: ['#34D399', 'rgba(52,211,153,.15)'],
    Codex: ['#A78BFA', 'rgba(167,139,250,.15)'],
    WorkBuddy: ['#22D3EE', 'rgba(34,211,238,.15)']
  }
  function srcColor(src) {
    var c = SRC_COLORS[src]
    if (c) return c
    return ['#FBBF24', 'rgba(251,191,36,.15)']
  }

  var STATE_LABEL = { running: '执行中', done: '完成', fail: '失败', error: '失败', queued: '排队', idle: '空闲' }
  function stateLabel(s) { return STATE_LABEL[s] || '执行中' }
  function stateCls(s) {
    if (s === 'done') return 'done'
    if (s === 'fail' || s === 'error') return 'fail'
    return 'running'
  }
  function progressOf(t) {
    if (t.state === 'done') return 100
    if (typeof t.progress === 'number') return Math.max(0, Math.min(100, t.progress))
    return t.state === 'running' ? 40 : 0
  }
  function ago(ts) {
    if (!ts) return ''
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
    if (s < 60) return s + '秒前'
    if (s < 3600) return Math.floor(s / 60) + '分钟前'
    return Math.floor(s / 3600) + '小时前'
  }
  function esc(s) { return String(s == null ? '' : s) }

  function makeCard(t) {
    var el = document.createElement('div')
    el.className = 'card'
    el.innerHTML =
      '<div class="top"></div>' +
      '<h4></h4>' +
      '<p></p>' +
      '<div class="bar"><i></i></div>' +
      '<div class="ts"><span class="srcTime"></span><span class="prc"></span></div>'
    cards[t.id] = el
    updateCard(el, t)
    grid.appendChild(el)
    return el
  }

  function updateCard(el, t) {
    var state = t.state === 'done' || t.state === 'fail' || t.state === 'error' ? t.state : 'running'
    el.className = 'card ' + stateCls(state)

    var col = srcColor(t.source)
    var top = el.querySelector('.top')
    top.innerHTML = '<span class="srcTag" style="color:' + col[0] + ';background:' + col[1] + '">' +
      esc(t.source || 'AI') + '</span>' +
      '<span class="stateChip" style="color:' + col[0] + ';border:1px solid ' + col[0] + '66">' +
      stateLabel(t.state) + '</span>'

    el.querySelector('h4').textContent = t.title || '未命名任务'
    el.querySelector('p').textContent = t.detail || t.title || ''
    var p = progressOf(t)
    var bar = el.querySelector('.bar i')
    bar.style.transform = 'scaleX(' + (p / 100) + ')'
    bar.classList.toggle('active', state === 'running')
    el.querySelector('.prc').textContent = (state === 'running') ? p + '%' : ''
    el.querySelector('.srcTime').textContent = ago(t.updatedAt)
  }

  function removeCard(id) {
    var el = cards[id]
    if (!el) return
    delete cards[id]
    el.classList.add('leaving')
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el) }, 190)
  }

  function reconcile(tasks) {
    var seen = {}
    for (var i = 0; i < (tasks || []).length; i++) {
      var t = tasks[i]
      if (!t || t.id == null) continue
      seen[t.id] = 1
      if (cards[t.id]) updateCard(cards[t.id], t)
      else makeCard(t)
    }
    for (var id in cards) if (!seen[id]) removeCard(id)
    // 空态：只在没有卡片时显示
    empty.classList.toggle('hidden', Object.keys(cards).length > 0)
    unifySize()
  }

  function renderMeta(meta) {
    if (!meta) return
    $('st-total').textContent = meta.total || 0
    $('st-run').textContent = meta.running || 0
    $('st-done').textContent = meta.done || 0
    $('st-fail').textContent = meta.failed || 0
  }

  function renderSrcs(tasks) {
    var srcs = $('srcs')
    var map = {}
    ;(tasks || []).forEach(function (t) { if (t.source) map[t.source] = 1 })
    var keys = Object.keys(map)
    srcs.innerHTML = ''
    if (keys.length === 0) return
    keys.slice(0, 4).forEach(function (s) {
      var c = srcColor(s)
      var chip = document.createElement('span')
      chip.className = 'src-chip'
      chip.style.color = c[0]
      chip.textContent = s
      srcs.appendChild(chip)
    })
  }

  // 动态控制浮窗高度：按内容自动伸缩，高度随任务数量变化（有上限，过多则内部换行排列）
  var lastH = -1
  function unifySize() {
    requestAnimationFrame(function () {
      var app = document.getElementById('app')
      if (!app) return
      var h = Math.ceil(app.offsetHeight) + 16   // +8 上下边距
      if (Math.abs(h - lastH) > 3) {
        lastH = h
        try { window.bobo.taskResize({ width: window.outerWidth, height: h }) } catch (e) {}
      }
    })
  }

  window.bobo.onTasksUpdate(function (d) {
    renderMeta(d.meta)
    renderSrcs(d.tasks)
    reconcile(d.tasks)
  })

  // 底部：接入提示 + 时钟
  window.bobo.getAiTasksInfo().then(function (info) {
    if (info && info.port) $('port').textContent = 'HTTP · 127.0.0.1:' + info.port
  })
  function tickClock() {
    var d = new Date()
    function z(n) { return (n < 10 ? '0' : '') + n }
    clock.textContent = z(d.getHours()) + ':' + z(d.getMinutes())
  }
  tickClock(); setInterval(tickClock, 1000)

  document.getElementById('close').addEventListener('click', function () {
    try { window.bobo.openAiTasks() } catch (e) {}
  })

  // 初始布局稳定后再统一一次尺寸
  window.addEventListener('load', function () { setTimeout(unifySize, 250) })
})()