(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var grid = $('grid')
  var tabs = $('tabs')
  var seg = $('seg')
  var empty = $('empty')
  var emptyNote = $('empty-note')
  var clock = $('clock')

  var cards = {}            // 卡片 id -> DOM（当前段内）
  var lastCardsSig = {}     // 卡片 id -> 上次渲染指纹，避免无谓重写
  var allSources = []
  var activeKey = null
  var segMap = {}           // source key -> 'running' | 'done'，默认 'running'
  var tabBtns = {}          // source key -> tab button DOM
  var renderedTabSig = null // 已渲染的 tab 集合指纹

  function sourceByKey(key) {
    for (var i = 0; i < allSources.length; i++) if (allSources[i].key === key) return allSources[i]
    return null
  }
  function segActive() { return segMap[activeKey] || 'running' }
  function segOfTask(t) {
    return (t.state === 'done' || t.state === 'fail' || t.state === 'error') ? 'done' : 'running'
  }
  function srcColor(src) {
    var s = sourceByKey(src)
    if (s && s.color) return s.color
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

  // ---------- Tab 栏：仅在来源集合变化时重建，否则只更新角标/高亮 ----------
  function srcsSig() {
    return allSources.filter(function (s) { return s.installed }).map(function (s) { return s.key }).join(',')
  }
  function renderTabs() {
    var sig = srcsSig()
    if (sig !== renderedTabSig) {
      tabs.innerHTML = ''
      tabBtns = {}
      sig.split(',').forEach(function (k) {
        if (!k) return
        var s = sourceByKey(k)
        var b = document.createElement('button')
        b.className = 'tab'
        b.dataset.key = k
        b.innerHTML = '<span class="tabDot"></span><span class="tabTxt"></span><span class="tabBadge"></span>'
        b.addEventListener('click', function () { switchKey(k) })
        tabs.appendChild(b)
        tabBtns[k] = b
      })
      renderedTabSig = sig
    }
    tabs.classList.toggle('hidden', sig === '')
    if (!activeKey || !sourceByKey(activeKey)) activeKey = sig.split(',')[0] || null
    var installed = allSources.filter(function (s) { return s.installed })
    installed.forEach(function (s) {
      var b = tabBtns[s.key]
      if (!b) return
      var c = s.color || ['#FBBF24', 'rgba(251,191,36,.15)']
      b.classList.toggle('on', s.key === activeKey)
      b.querySelector('.tabDot').style.background = c[0]
      b.querySelector('.tabTxt').textContent = s.label
      var n = (s.tasks || []).filter(function (t) { return segOfTask(t) === 'running' }).length
      var badge = b.querySelector('.tabBadge')
      badge.textContent = n > 0 ? n : ''
      badge.style.background = c[0]
      badge.style.display = n > 0 ? '' : 'none'
    })
  }

  function switchKey(k) {
    if (activeKey === k) return
    activeKey = k
    clearCards()
    renderAll()
  }

  // ---------- 分段：执行中 / 已完成 ----------
  function renderSeg() {
    var s = sourceByKey(activeKey)
    var tasks = s ? (s.tasks || []) : []
    var runN = 0, doneN = 0
    tasks.forEach(function (t) { if (segOfTask(t) === 'done') doneN++; else runN++ })
    $('seg-run-n').textContent = runN
    $('seg-done-n').textContent = doneN
    seg.classList.toggle('hidden', tasks.length === 0)
    seg.querySelector('[data-seg=running]').classList.toggle('on', segActive() === 'running')
    seg.querySelector('[data-seg=done]').classList.toggle('on', segActive() === 'done')
  }
  function switchSeg(segName) {
    if (segMap[activeKey] === segName) return
    segMap[activeKey] = segName
    clearCards()
    renderAll()
  }
  seg.addEventListener('click', function (e) {
    var btn = e.target.closest('button')
    if (btn) switchSeg(btn.getAttribute('data-seg'))
  })

  // ---------- 卡片：原地更新（无感刷新），切换时才整片重建 ----------
  function makeCard(t, appName) {
    var el = document.createElement('div')
    el.className = 'card'
    el.innerHTML =
      '<div class="top"></div><h4></h4><p></p><div class="bar"><i></i></div>' +
      '<div class="ts"><span class="srcTime"></span><span class="prc"></span></div>'
    cards[t.id] = el
    lastCardsSig[t.id] = ''
    updateCard(el, t, appName)
    grid.appendChild(el)
    return el
  }
  function updateCard(el, t, appName) {
    var st = t.state
    el.className = 'card ' + stateCls(st) + (appName ? ' clickable' : '')
    el.style.cursor = appName ? 'pointer' : ''
    var col = srcColor(t.source)
    el.querySelector('.top').innerHTML =
      '<span class="srcTag" style="color:' + col[0] + ';background:' + col[1] + '">' + esc(t.source || 'AI') + '</span>' +
      '<span class="stateChip" style="color:' + col[0] + ';border:1px solid ' + col[0] + '66">' + stateLabel(st) + '</span>'
    el.querySelector('h4').textContent = t.title || '未命名任务'
    el.querySelector('p').textContent = t.detail || t.title || ''
    var p = progressOf(t)
    var bar = el.querySelector('.bar i')
    bar.style.transform = 'scaleX(' + (p / 100) + ')'
    bar.classList.toggle('active', st === 'running')
    el.querySelector('.prc').textContent = (st === 'running') ? p + '%' : ''
    el.querySelector('.srcTime').textContent = ago(t.updatedAt)
  }
  function clearCards() {
    Object.keys(cards).forEach(function (id) {
      var el = cards[id]
      if (el && el.parentNode) el.parentNode.removeChild(el)
    })
    cards = {}
    lastCardsSig = {}
  }
  function cardSig(t) {
    return t.title + '|' + t.state + '|' + (t.progress == null ? '' : t.progress) + '|' + (t.detail || '') + '|' + (t.updatedAt || 0) + '|' + (t.source || '')
  }
  function reconcileFiltered(list, appName) {
    var filtered = (list || []).filter(function (t) { return segOfTask(t) === segActive() })
    var seen = {}
    for (var i = 0; i < filtered.length; i++) {
      var t = filtered[i]
      if (!t || t.id == null) continue
      seen[t.id] = 1
      if (cards[t.id]) {
        var sig = cardSig(t)
        if (lastCardsSig[t.id] !== sig) { updateCard(cards[t.id], t, appName); lastCardsSig[t.id] = sig }
      } else {
        makeCard(t, appName)
      }
    }
    for (var id in cards) {
      if (!seen[id]) {
        var el = cards[id]
        delete cards[id]
        delete lastCardsSig[id]
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }
    return filtered.length
  }
  function renderAll() {
    var s = sourceByKey(activeKey)
    renderSeg()
    empty.classList.add('hidden')
    if (!s) { reconcileFiltered([], null); unifySize(); return }
    var shown = reconcileFiltered(s.tasks || [], s.appName)
    if (shown === 0) {
      empty.classList.remove('hidden')
      emptyNote.textContent = s.note || '当前段内没有任务。'
    }
    unifySize()
  }

  // 动态控制浮窗高度：按内容自动伸缩（内容稳定时保持不变）
  var lastH = -1
  function unifySize() {
    requestAnimationFrame(function () {
      var app = document.getElementById('app')
      if (!app) return
      var h = Math.ceil(app.offsetHeight) + 16
      if (Math.abs(h - lastH) > 3) {
        lastH = h
        try { window.bobo.taskResize({ width: window.outerWidth, height: h }) } catch (e) {}
      }
    })
  }

  window.bobo.onTasksUpdate(function (d) {
    allSources = d.sources || []
    renderTabs()
    renderAll()
  })

  grid.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.card.clickable') : null
    if (!card) return
    var s = sourceByKey(activeKey)
    if (!s || !s.appName) return
    try { window.bobo.openToolApp(s.key) } catch (err) {}
  })

  window.bobo.getAiTasksInfo().then(function (info) {
    if (info && info.port) $('port').textContent = 'HTTP · 127.0.0.1:' + info.port
  })
  function tickClock() {
    var d = new Date()
    function z(n) { return (n < 10 ? '0' : '') + n }
    clock.textContent = z(d.getHours()) + ':' + z(d.getMinutes())
  }
  tickClock(); setInterval(tickClock, 1000)
  // 每分钟刷新一次"多久前"文案，配合无感原地更新
  setInterval(function () {
    if (!activeKey) return
    var s = sourceByKey(activeKey)
    if (!s) return
    var t = s.tasks || []
    for (var i = 0; i < t.length; i++) {
      var id = t[i].id
      var el = cards[id]
      if (el && segOfTask(t[i]) === segActive()) {
        var txt = ago(t[i].updatedAt)
        if (el.querySelector('.srcTime').textContent !== txt) el.querySelector('.srcTime').textContent = txt
      }
    }
  }, 60000)

  document.getElementById('close').addEventListener('click', function () {
    try { window.bobo.openAiTasks() } catch (e) {}
  })

  window.addEventListener('load', function () { setTimeout(unifySize, 250) })
})()