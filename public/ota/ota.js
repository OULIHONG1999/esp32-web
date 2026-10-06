/* OTA Console — 页面逻辑（零依赖、独立页）
 *
 * 两种模式：
 *   mock（默认）— 内置 §4.2 契约形状的假设备，无需后端，用于先开发页面；
 *   real        — 打真实 /api/devices 与 /api/registry（服务器端未实现时自动提示）。
 *
 * 契约依据：/docs/ota.md §4；机器描述符：/ota.json。
 */
;(function () {
  'use strict'

  var POLL_MS = 5000
  var MODE_KEY = 'ota.mode'
  /** 与主页面同一个键：在主站 🔑 里设过的 token 这里直接可用 */
  var TOKEN_KEY = 'fw.token'

  // ── 契约常量 ──────────────────────────────────────────────
  var STATE_LABEL = { pending: '待执行', delivered: '已投递', success: '成功', failed: '失败' }

  // ── DOM ──────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id) }
  var el = {
    modeToggle: $('modeToggle'), refreshBtn: $('refreshBtn'),
    deviceGrid: $('deviceGrid'), deviceEmpty: $('deviceEmpty'),
    cOnline: $('cOnline'), cOffline: $('cOffline'), cPending: $('cPending'),
    cSuccess: $('cSuccess'), cFailed: $('cFailed'), srcLabel: $('srcLabel'),
    pollLabel: $('pollLabel'), lastRefresh: $('lastRefresh'),
    dDevice: $('dDevice'), dRelease: $('dRelease'), sendBtn: $('sendBtn'),
    dToken: $('dToken'), dForce: $('dForce'), tokenState: $('tokenState'),
    resolved: $('resolved'), notice: $('notice')
  }

  // ── 状态 ─────────────────────────────────────────────────
  var state = {
    mode: 'mock',
    devices: [],
    releases: [],
    selectedId: '',
    token: '',
    timer: null,
    lastError: ''
  }

  // ══ mock 数据（§4.2 形状；时间戳动态生成）════════════════
  function nowMinus(sec) { return new Date(Date.now() - sec * 1000).toISOString() }

  function mockDevices() {
    return [
      {
        deviceId: '3485a1b2c3d4', chip: 'ESP32-S3',
        firmwareVersion: 'v0.6.0-3-g64de242',
        appSha256: '27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d',
        sdkVersion: 'v6.0.1', ip: '192.168.31.100',
        online: true, lastSeen: nowMinus(6), createdAt: nowMinus(7200),
        lastCommand: { id: 'cmd_2f3c9a', type: 'ota', releaseId: '20261005-1609-278773', state: 'success' }
      },
      {
        deviceId: '7c9ebd112233', chip: 'ESP32-S3',
        firmwareVersion: 'v0.5.2',
        appSha256: 'aa11bb22cc33dd44ee55ff6600778899aabbccddeeff00112233445566778899',
        sdkVersion: 'v6.0.0', ip: '192.168.31.117',
        online: true, lastSeen: nowMinus(18), createdAt: nowMinus(3600),
        lastCommand: { id: 'cmd_71ab04', type: 'ota', releaseId: '20261005-1609-278773', state: 'pending' }
      },
      {
        deviceId: 'a0b1c2d3e4f5', chip: 'ESP32-S3',
        firmwareVersion: 'v0.6.0-3-g64de242',
        appSha256: '27877362ce8b9524b4e1650cb9b46b80bbd29cec535748ce88580600b9214e2d',
        sdkVersion: 'v6.0.1', ip: '192.168.31.141',
        online: false, lastSeen: nowMinus(430), createdAt: nowMinus(10800),
        lastCommand: null
      }
    ]
  }

  function mockRegistry() {
    return {
      projects: {
        'lvgl-demo-v9': {
          id: 'lvgl-demo-v9', name: 'LVGL Demo V9', subscribed: true, retention: 6,
          variants: {
            'ESP32-S3': {
              latest: '20261005-1609-278773',
              releases: [
                { id: '20261005-1609-278773', type: 'release', chipFamily: 'ESP32-S3', note: 'OTA 基线条', createdAt: '2026-10-05T16:09:00Z', parts: [] },
                { id: '20261004-1011-a1b2c3', type: 'snapshot', chipFamily: 'ESP32-S3', note: '调试快照', createdAt: '2026-10-04T10:11:00Z', parts: [] }
              ]
            }
          }
        }
      }
    }
  }

  // ══ 取数 ════════════════════════════════════════════════
  /** fetch + JSON；非 2xx 时把服务端 error 文案与状态码一起抛出（便于按码给提示） */
  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (text) {
        var json = null
        try { json = text ? JSON.parse(text) : null } catch (e) { json = null }
        if (!r.ok) {
          var err = new Error((json && json.error) || ('HTTP ' + r.status))
          err.status = r.status
          err.body = json
          throw err
        }
        return json
      })
    })
  }

  /** 把失败翻译成「下一步做什么」——而不是笼统的「服务器未实现」 */
  function dispatchHint(err) {
    if (err.status === 401) {
      return '鉴权失败（401）：下发需要 token。在下方「Token」填入主 token 或 wk_ 工作 token 后重试；' +
        '没有的话到主站右上角 🔑 生成一个工作 token。'
    }
    if (err.status === 409) {
      var c = err.body && err.body.command
      return '该设备已有未回执命令（409）' + (c ? '：' + c.state + ' · ' + c.id : '') +
        '。勾选「顶替未决命令」后重试，或等设备回执。'
    }
    if (err.status === 404) {
      return '服务器上没有这个 release（404）：' + err.message + '。可能是版本已被回滚/清理，刷新页面重选。'
    }
    if (err.status === 413) return '请求体过大（413）。'
    if (err.status) return '服务器返回 ' + err.status + '：' + err.message
    return '连不上服务器：' + err.message + '（检查网络与该地址是否可达）'
  }

  function loadMock() {
    state.devices = mockDevices()
    state.releases = flattenReleases(mockRegistry())
    state.lastError = ''
  }

  function loadReal() {
    return Promise.all([fetchJson('/api/devices'), fetchJson('/api/registry')])
      .then(function (res) {
        state.devices = Array.isArray(res[0].devices) ? res[0].devices : []
        state.releases = flattenReleases(res[1])
        state.lastError = ''
      })
      .catch(function (err) {
        state.devices = []
        state.releases = []
        state.lastError = err.message
      })
  }

  /** registry → 扁平 release 列表 [{projectId, variant, id, type, note, createdAt}] */
  function flattenReleases(reg) {
    var out = []
    var projects = (reg && reg.projects) || {}
    Object.keys(projects).forEach(function (pid) {
      var variants = projects[pid].variants || {}
      Object.keys(variants).forEach(function (vid) {
        ;(variants[vid].releases || []).forEach(function (r) {
          out.push({
            projectId: pid, variant: vid, id: r.id, type: r.type,
            note: r.note || '', createdAt: r.createdAt || '',
            isLatest: variants[vid].latest === r.id
          })
        })
      })
    })
    return out.sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || '') })
  }

  function load() {
    var p = state.mode === 'mock' ? Promise.resolve(loadMock()) : loadReal()
    return p.then(function () {
      render()
      el.lastRefresh.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    })
  }

  // ══ 渲染 ════════════════════════════════════════════════
  function fmtMac(id) {
    if (!/^[0-9a-f]{12}$/i.test(id)) return id
    return id.toLowerCase().match(/.{2}/g).join(':')
  }
  function fmtAgo(iso) {
    if (!iso) return '—'
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
    if (s < 60) return s + 's 前'
    if (s < 3600) return Math.round(s / 60) + 'm 前'
    return Math.round(s / 3600) + 'h 前'
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  function render() {
    el.srcLabel.textContent = state.mode
    el.pollLabel.textContent = POLL_MS / 1000 + 's'
    renderPills()
    renderDevices()
    renderDeviceOptions()
    renderReleaseOptions()
    renderResolved()
  }

  function renderPills() {
    var d = state.devices
    el.cOnline.textContent = d.filter(function (x) { return x.online }).length
    el.cOffline.textContent = d.filter(function (x) { return !x.online }).length
    el.cPending.textContent = d.filter(function (x) { return x.lastCommand && (x.lastCommand.state === 'pending' || x.lastCommand.state === 'delivered') }).length
    el.cSuccess.textContent = d.filter(function (x) { return x.lastCommand && x.lastCommand.state === 'success' }).length
    el.cFailed.textContent = d.filter(function (x) { return x.lastCommand && x.lastCommand.state === 'failed' }).length
  }

  function chip(st) {
    var k = STATE_LABEL[st] ? st : 'none'
    return '<span class="chip chip--' + k + '">' + esc(STATE_LABEL[st] || '无命令') + '</span>'
  }

  function renderDevices() {
    el.deviceEmpty.hidden = state.devices.length > 0
    el.deviceGrid.innerHTML = state.devices.map(function (d) {
      var cmd = d.lastCommand
      return '' +
        '<article class="dev' + (d.deviceId === state.selectedId ? ' is-selected' : '') + (d.online ? '' : ' is-offline') + '" data-id="' + esc(d.deviceId) + '">' +
          '<div class="dev__hd">' +
            '<span class="dot ' + (d.online ? 'dot--on' : 'dot--off') + '"></span>' +
            '<span class="dev__id">' + esc(fmtMac(d.deviceId)) + '</span>' +
            '<span class="dev__state">' + (d.online ? '在线' : '离线') + '</span>' +
          '</div>' +
          '<dl class="dev__kv">' +
            '<dt>芯片</dt><dd>' + esc(d.chip || '—') + '</dd>' +
            '<dt>固件</dt><dd>' + esc(d.firmwareVersion || '—') + '</dd>' +
            '<dt>IP</dt><dd>' + esc(d.ip || '—') + '</dd>' +
            '<dt>心跳</dt><dd>' + esc(fmtAgo(d.lastSeen)) + '</dd>' +
            '<dt>SDK</dt><dd>' + esc(d.sdkVersion || '—') + '</dd>' +
          '</dl>' +
          '<div class="dev__cmd">' +
            '<span class="lbl">最近命令</span>' +
            (cmd ? chip(cmd.state) + '<span class="rid">' + esc(cmd.id || '') + '</span>' : '<span class="chip chip--none">无命令</span>') +
          '</div>' +
          '<div class="dev__actions">' +
            '<button class="btn btn--sm" data-act="select">选择并下发</button>' +
          '</div>' +
        '</article>'
    }).join('')
  }

  function renderDeviceOptions() {
    var keep = el.dDevice.value
    var opts = ['<option value="">— 先在上方选一台设备 —</option>']
    state.devices.forEach(function (d) {
      var tag = d.online ? '' : '（离线）'
      opts.push('<option value="' + esc(d.deviceId) + '">' + esc(fmtMac(d.deviceId) + ' · ' + (d.chip || '?') + ' · ' + (d.firmwareVersion || '?') + tag) + '</option>')
    })
    el.dDevice.innerHTML = opts.join('')
    var want = keep || state.selectedId
    if (want) el.dDevice.value = want
    state.selectedId = el.dDevice.value
  }

  function renderReleaseOptions() {
    var keep = el.dRelease.value
    var opts = ['<option value="">— 选择 release —</option>']
    state.releases.forEach(function (r) {
      var mark = r.isLatest ? '★ ' : ''
      opts.push('<option value="' + esc(r.id) + '">' + mark + esc(r.projectId + ' / ' + r.variant + ' · ' + r.id) + '</option>')
    })
    el.dRelease.innerHTML = opts.join('')
    if (keep) el.dRelease.value = keep
  }

  function findRelease(id) {
    for (var i = 0; i < state.releases.length; i++) if (state.releases[i].id === id) return state.releases[i]
    return null
  }

  function renderResolved() {
    var dev = el.dDevice.value
    var rel = findRelease(el.dRelease.value)
    el.sendBtn.disabled = !(dev && rel)
    renderTokenState()
    if (!dev) { el.resolved.hidden = true; return }
    el.resolved.hidden = false
    var needToken = state.mode === 'real' && !state.token
    el.resolved.innerHTML =
      '将下发：<b>' + esc(fmtMac(dev)) + '</b> → ' +
      (rel
        ? '<code>' + esc(rel.projectId + ' / ' + rel.variant + ' / ' + rel.id) + '</code>'
        : '<span style="color:var(--warn)">尚未选择 release</span>') +
      (needToken ? ' <span style="color:var(--warn)">· 还缺 Token（下方填写）</span>' : '')
  }

  /** Token 状态提示：real 模式下没 token 会 401，提前告诉用户 */
  function renderTokenState() {
    if (!el.tokenState) return
    if (state.token) {
      el.tokenState.textContent = '已设置'
      el.tokenState.className = 'tokstate tokstate--ok'
    } else if (state.mode === 'real') {
      el.tokenState.textContent = '未设置（下发会 401）'
      el.tokenState.className = 'tokstate tokstate--warn'
    } else {
      el.tokenState.textContent = 'mock 模式不需要'
      el.tokenState.className = 'tokstate'
    }
  }

  function notice(kind, text) {
    el.notice.hidden = false
    el.notice.className = 'notice notice--' + kind
    el.notice.textContent = text
  }

  // ══ 交互 ════════════════════════════════════════════════
  el.deviceGrid.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act="select"]')
    if (!btn) return
    var card = btn.closest('.dev')
    state.selectedId = card.getAttribute('data-id')
    el.dDevice.value = state.selectedId
    renderDevices(); renderResolved()
    el.dDevice.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })

  el.dDevice.addEventListener('change', function () { state.selectedId = el.dDevice.value; renderDevices(); renderResolved() })
  el.dRelease.addEventListener('change', renderResolved)

  // Token：输入即存本机（不上传），与主站共用 fw.token
  if (el.dToken) {
    el.dToken.addEventListener('input', function () {
      state.token = el.dToken.value.trim()
      try {
        if (state.token) localStorage.setItem(TOKEN_KEY, state.token)
        else localStorage.removeItem(TOKEN_KEY)
      } catch (e) { /* 隐私模式忽略 */ }
      renderTokenState()
      renderResolved()
    })
  }
  if (el.dForce) el.dForce.addEventListener('change', renderResolved)

  el.sendBtn.addEventListener('click', function () {
    var deviceId = el.dDevice.value
    var releaseId = el.dRelease.value
    if (!deviceId || !releaseId) return
    if (state.mode === 'mock') return mockDispatch(deviceId, releaseId)
    realDispatch(deviceId, releaseId)
  })

  /** mock：本地生成命令并模拟 pending → delivered → success 流转 */
  function mockDispatch(deviceId, releaseId) {
    var dev = state.devices.filter(function (d) { return d.deviceId === deviceId })[0]
    if (!dev) return notice('err', '设备不存在：' + deviceId)

    var id = 'cmd_' + Math.random().toString(16).slice(2, 8)
    dev.lastCommand = { id: id, type: 'ota', releaseId: releaseId, state: 'pending' }
    notice('ok', '已下发（mock）' + id + ' → ' + fmtMac(deviceId) + '；将模拟 pending → delivered → success')
    render()

    setTimeout(function () { dev.lastCommand.state = 'delivered'; render() }, 2000)
    setTimeout(function () {
      dev.lastCommand.state = 'success'
      dev.firmwareVersion = releaseId
      render()
      notice('ok', '命令 ' + id + ' 已回执 success（mock）')
    }, 6000)
  }

  /** real：POST 真实接口（带 Bearer token）；失败按状态码给可操作提示 */
  function realDispatch(deviceId, releaseId) {
    if (!state.token) {
      notice('err', '请先填 Token——下发是写操作，服务器要求 Bearer 鉴权（上报/回执才是免鉴权的）。')
      if (el.dToken) el.dToken.focus()
      return
    }
    el.sendBtn.disabled = true
    notice('info', '正在下发…')
    var body = { type: 'ota', releaseId: releaseId }
    if (el.dForce && el.dForce.checked) body.force = true
    fetchJson('/api/devices/' + encodeURIComponent(deviceId) + '/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
      body: JSON.stringify(body)
    }).then(function (res) {
      var cmd = res.command || {}
      notice('ok', '已下发 ' + (cmd.id || '') + '（' + (cmd.state || 'pending') + '）→ ' + fmtMac(deviceId) +
        '；等设备下次上报取走后状态会变 delivered。')
      return load()
    }).catch(function (err) {
      notice('err', '下发失败：' + dispatchHint(err))
    }).then(function () { renderResolved() })
  }

  el.refreshBtn.addEventListener('click', function () { load() })

  el.modeToggle.addEventListener('change', function () {
    state.mode = el.modeToggle.checked ? 'real' : 'mock'
    try { localStorage.setItem(MODE_KEY, state.mode) } catch (e) { /* 隐私模式忽略 */ }
    state.selectedId = ''
    el.dDevice.value = ''
    el.notice.hidden = true
    load().then(function () {
      if (state.mode === 'real' && state.lastError) {
        notice('err', 'real 模式取数失败：' + state.lastError + '（检查网络/地址是否可达）')
      } else if (state.mode === 'real' && state.devices.length === 0) {
        notice('info', 'real 模式已连通，但暂无设备上报（设备端会在首次 report 后出现在这里）。切回 mock 可看样例。')
      } else if (state.mode === 'real' && !state.token) {
        notice('info', 'real 模式已连通。注意：下发是写操作，需要先在下方填 Token（上报/回执免鉴权）。')
      }
      renderTokenState()
    })
  })

  // ══ 启动 ════════════════════════════════════════════════
  try { state.mode = localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'mock' } catch (e) { /* ignore */ }
  try { state.token = localStorage.getItem(TOKEN_KEY) || '' } catch (e) { /* ignore */ }
  if (el.dToken) el.dToken.value = state.token
  el.modeToggle.checked = state.mode === 'real'
  state.selectedId = ''

  load()
  state.timer = setInterval(load, POLL_MS)
  window.addEventListener('beforeunload', function () { clearInterval(state.timer) })
})()
