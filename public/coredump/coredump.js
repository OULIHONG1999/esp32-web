/* 崩溃上报台 — 页面逻辑（零依赖、独立页）
 *
 * 数据全部来自服务器实时接口，**无本地假数据**：
 *   GET /api/coredumps   全部崩溃列表（含 downloadUrl）
 *
 * 契约依据：/docs/coredump.md §5；机器描述符：/coredump.json。
 * 只读页面：无需 token，不做符号化（那是离线动作，见 /docs/coredump.md §7）。
 */
;(function () {
  'use strict'

  var POLL_MS = 5000
  var $ = function (id) { return document.getElementById(id) }
  var el = {
    refreshBtn: $('refreshBtn'),
    cTotal: $('cTotal'), cDevices: $('cDevices'), cLast: $('cLast'), connState: $('connState'),
    pollLabel: $('pollLabel'), lastRefresh: $('lastRefresh'),
    deviceFilter: $('deviceFilter'),
    listBody: $('listBody'), listEmpty: $('listEmpty'),
    detailPanel: $('detailPanel'), detailId: $('detailId'), detailBody: $('detailBody'),
  }
  var state = { all: [], filter: '', selectedId: '', timer: null }

  // ── 工具 ────────────────────────────────────────────────
  /** 转义设备侧文本（panicReason 等来自设备，必须防 XSS） */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function timeAgo(iso) {
    if (!iso) return '—'
    var t = Date.parse(iso)
    if (!Number.isFinite(t)) return esc(iso)
    var diff = Date.now() - t
    if (diff < 0) diff = 0
    var s = Math.floor(diff / 1000)
    if (s < 60) return '刚刚'
    var m = Math.floor(s / 60)
    if (m < 60) return m + ' 分钟前'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    var d = Math.floor(h / 24)
    if (d < 7) return d + ' 天前'
    var dt = new Date(t)
    return dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString()
  }

  function fmtBytes(n) {
    if (n == null) return '—'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(2) + ' MB'
  }

  // ── 数据加载 ────────────────────────────────────────────
  function load() {
    fetch('/api/coredumps').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).then(function (json) {
      state.all = json.coredumps || []
      el.connState.textContent = '已连接'
      el.connState.className = 'conn--ok'
      render()
    }).catch(function () {
      el.connState.textContent = '连接失败'
      el.connState.className = 'conn--err'
    })
  }

  // ── 渲染 ────────────────────────────────────────────────
  function render() {
    var all = state.all
    el.cTotal.textContent = all.length
    var devs = {}
    all.forEach(function (c) { devs[c.deviceId] = true })
    el.cDevices.textContent = Object.keys(devs).length
    el.cLast.textContent = all.length ? timeAgo(all[0].receivedAt) : '—'
    el.lastRefresh.textContent = new Date().toLocaleTimeString()
    renderFilter()
    renderList()
    if (state.selectedId) renderDetail()
  }

  function renderFilter() {
    var current = el.deviceFilter.value
    var devs = {}
    state.all.forEach(function (c) { devs[c.deviceId] = true })
    var ids = Object.keys(devs).sort()
    var html = '<option value="">全部设备</option>'
    ids.forEach(function (id) {
      html += '<option value="' + esc(id) + '">' + esc(id) + '</option>'
    })
    el.deviceFilter.innerHTML = html
    if (current) el.deviceFilter.value = current
  }

  function cardHtml(c) {
    var reason = c.panicReason || '（无 panic 原因）'
    return (
      '<div class="dump" data-id="' + esc(c.id) + '">' +
        '<div class="dump__bar"></div>' +
        '<div class="dump__main">' +
          '<div class="dump__top">' +
            '<span class="dump__dev">' + esc(c.deviceId) + '</span>' +
            '<span class="dump__time">' + timeAgo(c.receivedAt) + ' · ' + esc(c.receivedAt) + '</span>' +
          '</div>' +
          '<div class="dump__reason dump__reason--clip">' + esc(reason) + '</div>' +
          '<div class="dump__meta">' +
            (c.excTask ? '<span class="tag tag--task">' + esc(c.excTask) + '</span>' : '') +
            (c.firmwareVersion ? '<span class="tag">' + esc(c.firmwareVersion) + '</span>' : '') +
            (c.chip ? '<span class="tag">' + esc(c.chip) + '</span>' : '') +
            '<span class="tag">' + fmtBytes(c.size) + '</span>' +
            '<span class="tag">' + esc(c.sha256.slice(0, 12)) + '…</span>' +
          '</div>' +
        '</div>' +
        '<div class="dump__ops">' +
          '<button class="btn" data-action="detail" data-id="' + esc(c.id) + '">详情</button>' +
          '<a class="btn" href="' + esc(c.downloadUrl) + '" download>下载</a>' +
        '</div>' +
      '</div>'
    )
  }

  function renderList() {
    var list = state.all
    if (state.filter) list = list.filter(function (c) { return c.deviceId === state.filter })
    el.listEmpty.hidden = list.length > 0
    el.listBody.innerHTML = list.map(cardHtml).join('')
  }

  function renderDetail() {
    var c = null
    for (var i = 0; i < state.all.length; i++) {
      if (state.all[i].id === state.selectedId) { c = state.all[i]; break }
    }
    if (!c) {
      el.detailPanel.hidden = true
      state.selectedId = ''
      return
    }
    el.detailPanel.hidden = false
    el.detailId.textContent = c.id
    var rows = [
      ['设备', c.deviceId],
      ['接收时间', c.receivedAt],
      ['固件版本', c.firmwareVersion || '—'],
      ['芯片 / SDK', (c.chip || '—') + '  /  ' + (c.sdkVersion || '—')],
      ['崩溃任务', c.excTask || '—'],
      ['崩溃 PC', c.excPc || '—'],
      ['大小', fmtBytes(c.size)],
      ['sha256', c.sha256],
      ['app ELF sha256', c.appElfSha256 || '—'],
      ['panic 原因', c.panicReason || '—'],
    ]
    var html = '<div class="kv">'
    rows.forEach(function (r) {
      html += '<div><dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd></div>'
    })
    html += '</div>'
    html +=
      '<div class="detail__ops">' +
        '<a class="btn btn--p" href="' + esc(c.downloadUrl) + '" download>下载原始 dump</a>' +
        '<button class="btn btn--ghost" data-action="close">关闭</button>' +
      '</div>'
    el.detailBody.innerHTML = html
  }

  // ── 事件 ────────────────────────────────────────────────
  el.listBody.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]')
    if (!btn) return
    var id = btn.getAttribute('data-id')
    if (btn.getAttribute('data-action') === 'detail') {
      state.selectedId = id
      renderDetail()
      el.detailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (btn.getAttribute('data-action') === 'close') {
      state.selectedId = ''
      el.detailPanel.hidden = true
    }
  })

  el.deviceFilter.addEventListener('change', function () {
    state.filter = el.deviceFilter.value
    renderList()
  })
  el.refreshBtn.addEventListener('click', load)

  // ── 启动 ────────────────────────────────────────────────
  el.pollLabel.textContent = (POLL_MS / 1000) + 's'
  load()
  state.timer = setInterval(load, POLL_MS)
})()
