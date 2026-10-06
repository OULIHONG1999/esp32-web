/* OTA Console — 页面逻辑（零依赖、独立页）
 *
 * 数据全部来自服务器实时接口，**无本地假数据**：
 *   GET  /api/devices               设备列表（含 online / lastCommand）
 *   GET  /api/registry              固件版本（下拉选项）
 *   POST /api/devices/{id}/commands 下发（需 Bearer token）
 *
 * 契约依据：/docs/ota.md §4；机器描述符：/ota.json；设备端接入：/docs/DEVICE-OTA.md。
 */
;(function () {
  'use strict'

  var POLL_MS = 5000
  /** 与主页面同一个键：在主站 🔑 里设过的 token 这里直接可用 */
  var TOKEN_KEY = 'fw.token'

  // ── 契约常量 ──────────────────────────────────────────────
  var STATE_LABEL = { pending: '待执行', delivered: '已投递', success: '成功', failed: '失败', superseded: '已顶替' }

  /** 过程阶段的标签；设备端上报自定义阶段时原样显示（服务器不拦） */
  var PHASE_LABEL = {
    downloading: '下载固件',
    verifying: '校验 sha256',
    writing: '写入 OTA 槽',
    rebooting: '重启',
    applying: '启动确认'
  }
  /** 过程链的固定顺序（设备端按此推进；跳步也能画） */
  var PHASE_ORDER = ['downloading', 'verifying', 'writing', 'rebooting', 'applying']
  /** 卡住判定阈值：这些数字就是"看不见过程"时的解释力 */
  var STUCK = { pendingMs: 30000, silentMs: 120000, staleMs: 60000 }

  // ── DOM ──────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id) }
  var el = {
    refreshBtn: $('refreshBtn'),
    deviceGrid: $('deviceGrid'), deviceEmpty: $('deviceEmpty'),
    cOnline: $('cOnline'), cOffline: $('cOffline'), cPending: $('cPending'),
    cSuccess: $('cSuccess'), cFailed: $('cFailed'), connState: $('connState'),
    pollLabel: $('pollLabel'), lastRefresh: $('lastRefresh'),
    dDevice: $('dDevice'), dRelease: $('dRelease'), sendBtn: $('sendBtn'),
    dToken: $('dToken'), dForce: $('dForce'), tokenState: $('tokenState'),
    copyLinkBtn: $('copyLinkBtn'),
    procBody: $('procBody'), procHint: $('procHint'),
    resolved: $('resolved'), notice: $('notice')
  }

  // ── 状态 ─────────────────────────────────────────────────
  var state = {
    devices: [],
    releases: [],
    selectedId: '',
    token: '',
    timer: null,
    lastError: '',
    hadError: false
  }

  // ══ 设置链接 / 剪贴板 ═══════════════════════════════════
  /**
   * 设置链接：`/OTA#token=wk_xxx` 打开即写入本机。
   * 用片段（`#`）而不是查询串：浏览器不把片段发给服务器，所以不会进 nginx 日志。
   * 兼容旧形态 `?settoken=`。返回本次从链接读到的 token（没有则空串）。
   */
  function consumeTokenFromUrl() {
    var fragText = (location.hash || '').replace(/^#/, '')
    var frag = new URLSearchParams(fragText)
    var query = new URLSearchParams(location.search)
    var token = (frag.get('token') || '').trim() || (query.get('settoken') || '').trim()
    if (!token) return ''
    try { localStorage.setItem(TOKEN_KEY, token) } catch (e) { /* 隐私模式忽略 */ }
    frag.delete('token')
    query.delete('settoken')
    try {
      var hash = frag.toString() ? '#' + frag.toString() : ''
      var search = query.toString() ? '?' + query.toString() : ''
      history.replaceState(null, '', location.pathname + search + hash)
    } catch (e) { /* ignore */ }
    return token
  }

  /** 复制到剪贴板（非安全上下文没有 clipboard API → 退回 execCommand） */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true },
        function () { return legacyCopy(text) }
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (e) {
      return false
    }
  }

  /** 本页的设置链接（同源同路径 + 片段） */
  function settingsLink() {
    return location.origin + location.pathname + '#token=' + encodeURIComponent(state.token)
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

  /** 拉实时数据：设备列表 + 固件版本；失败时清空并记下错误（页面会显示「连接失败」） */
  function loadData() {
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
    return loadData().then(function () {
      render()
      el.lastRefresh.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      // 连接状态按「跃迁」提示：失败只报一次、恢复也说一声；
      // 否则每次轮询都刷提示，会把下发结果等消息顶掉。
      var failed = !!state.lastError
      if (failed && !state.hadError) {
        notice('err', '取数失败：' + state.lastError + '（检查网络、地址是否可达、服务是否在跑）')
      } else if (!failed && state.hadError) {
        notice('info', '连接已恢复。')
      }
      state.hadError = failed
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
    el.connState.textContent = state.lastError ? '连接失败' : '已连接'
    el.connState.className = state.lastError ? 'conn--err' : 'conn--ok'
    el.pollLabel.textContent = POLL_MS / 1000 + 's'
    renderPills()
    renderDevices()
    renderDeviceOptions()
    renderReleaseOptions()
    renderResolved()
    renderProcess()
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

  // ══ OTA 过程视图 ════════════════════════════════════════
  // 目的：下发之后能看见"进行到哪一步 / 卡在哪 / 一共多久"。
  // 数据来源分两层，谁有就用谁：
  //   服务器时间点（一定有）：createdAt → deliveredAt → finishedAt + detail
  //   设备过程点（设备端上报才有）：progress.phase/percent + trail
  function phaseLabel(p) {
    return PHASE_LABEL[p] || String(p || '?')
  }

  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—'
    var s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '')
    return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '')
  }

  /** 某时刻距 createdAt 的耗时（- 表示还没发生） */
  function elapsedFrom(cmd, iso) {
    if (!iso || !cmd.createdAt) return NaN
    return new Date(iso).getTime() - new Date(cmd.createdAt).getTime()
  }

  function sinceMs(iso) {
    if (!iso) return NaN
    return Date.now() - new Date(iso).getTime()
  }

  function clock(iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false })
  }

  /** 过程链：已下发 → 设备取走 → 5 个阶段 → 回执；返回每一步的状态 */
  function stepChain(cmd) {
    var total = PHASE_ORDER.length + 3
    var labels = ['已下发', '设备取走']
    PHASE_ORDER.forEach(function (p) { labels.push(PHASE_LABEL[p]) })
    labels.push('回执')

    // 设备端上报的阶段（progress 优先，退化到 trail 的最后一条）
    var pi = -1
    if (cmd.progress && cmd.progress.phase) pi = PHASE_ORDER.indexOf(cmd.progress.phase)
    if (pi < 0 && cmd.trail && cmd.trail.length) {
      pi = PHASE_ORDER.indexOf(cmd.trail[cmd.trail.length - 1].phase)
    }

    // done = 已完成的步数（0 = 连"已下发"都还没有，实际不会出现）
    var done = 1
    if (cmd.deliveredAt || cmd.state !== 'pending') done = 2
    if (pi >= 0) done = 2 + pi
    if (cmd.state === 'success') done = total

    var failAt = -1
    if (cmd.state === 'failed') failAt = pi >= 0 ? 2 + pi : Math.min(done, total - 1)
    var offAt = -1
    if (cmd.state === 'superseded') offAt = Math.min(done, total - 1)

    var states = []
    for (var i = 0; i < total; i++) {
      if (i < done) states.push('done')
      else if (i > done) states.push('wait')
      else if (i === failAt) states.push('fail')
      else if (i === offAt) states.push('off')
      else states.push(cmd.state === 'pending' || cmd.state === 'delivered' ? 'cur' : 'done')
    }
    return { labels: labels, states: states }
  }

  /** 结论行：过程在动 / 卡住 / 结束，都要说人话 */
  function verdict(cmd) {
    var waited = sinceMs(cmd.createdAt)
    if (cmd.state === 'pending') {
      var t = '已下发 ' + fmtDur(waited) + '，等设备下次上报时取走（设备每 ~15s 上报一次）。'
      if (waited > STUCK.pendingMs) {
        return { kind: 'warn', text: t + '还没被取走——设备离线、或没在跑上报循环。' }
      }
      return { kind: 'info', text: t }
    }
    if (cmd.state === 'delivered') {
      var took = '设备于 ' + fmtDur(elapsedFrom(cmd, cmd.deliveredAt)) + '（' + clock(cmd.deliveredAt) + '）取走，至今 ' + fmtDur(sinceMs(cmd.deliveredAt)) + '。'
      if (cmd.progress) {
        var stale = sinceMs(cmd.progress.updatedAt)
        var cur = '当前：' + phaseLabel(cmd.progress.phase) +
          (cmd.progress.percent !== undefined ? ' ' + cmd.progress.percent + '%' : '') +
          (cmd.progress.message ? '（' + esc(cmd.progress.message) + '）' : '')
        if (stale > STUCK.staleMs) {
          return { kind: 'warn', text: took + cur + '，但已 ' + fmtDur(stale) + ' 没有更新——写入大固件会慢，若超过几分钟多半是断了。' }
        }
        return { kind: 'ok', text: took + cur + '（' + fmtDur(stale) + ' 前更新）' }
      }
      var note = took + '设备取走后还没有过程上报。'
      if (cmd.deliveryCount > 1) {
        note += '注意：这条命令被取走 ' + cmd.deliveryCount + ' 次（服务器会重复投递，设备端需幂等）。'
      }
      if (sinceMs(cmd.deliveredAt) > STUCK.silentMs) {
        note += '已超过 ' + fmtDur(STUCK.silentMs) + ' 没动静：设备端可能没实现过程上报（那就在写入中，看不到细节）、或已断电。'
        return { kind: 'warn', text: note }
      }
      return { kind: 'info', text: note }
    }
    if (cmd.state === 'success') {
      return {
        kind: 'ok',
        text: '成功 · 总耗时 ' + fmtDur(elapsedFrom(cmd, cmd.finishedAt)) +
          (cmd.detail ? ' · ' + esc(cmd.detail) : ''),
      }
    }
    if (cmd.state === 'failed') {
      return {
        kind: 'err',
        text: '失败 · 耗时 ' + fmtDur(elapsedFrom(cmd, cmd.finishedAt)) +
          (cmd.detail ? ' · ' + esc(cmd.detail) : '（设备没给 detail）'),
      }
    }
    return { kind: 'info', text: '已被新命令顶替（superseded）。' }
  }

  /** 设备卡上的一行过程摘要（不点开也能看出在动） */
  function shortProgress(cmd) {
    if (!cmd) return ''
    var v = verdict(cmd)
    return '<div class="dev__prog dev__prog--' + v.kind + '">' + v.text + '</div>'
  }

  function renderProcess() {
    if (!el.procBody) return
    var dev = null
    for (var i = 0; i < state.devices.length; i++) {
      if (state.devices[i].deviceId === state.selectedId) dev = state.devices[i]
    }
    el.procHint.textContent = dev ? fmtMac(dev.deviceId) : '未选设备'
    if (!dev) {
      el.procBody.innerHTML = '<p class="empty">先在上方设备清单里点一台设备（「选择并下发」），这里会显示它最近一条 OTA 命令的过程。</p>'
      return
    }
    var cmd = dev.lastCommand
    if (!cmd) {
      el.procBody.innerHTML = '<p class="empty">这台设备还没有命令记录。下发一条后，过程会实时出现在这里。</p>'
      return
    }

    var chain = stepChain(cmd)
    var stepsHtml = '<ol class="steps">' + chain.labels.map(function (label, i) {
      return '<li class="step step--' + chain.states[i] + '"><span class="step__dot"></span>' + esc(label) + '</li>'
    }).join('') + '</ol>'

    var v = verdict(cmd)
    var verdictHtml = '<p class="verdict verdict--' + v.kind + '">' + v.text + '</p>'

    // 时间线：服务器时间点 + 设备过程点，按时间顺序
    var rows = [{ at: cmd.createdAt, label: '已下发', extra: 'release ' + (cmd.releaseId || '?') }]
    if (cmd.deliveredAt) {
      rows.push({
        at: cmd.deliveredAt,
        label: '设备取走',
        extra: cmd.deliveryCount > 1 ? '重复投递 ' + cmd.deliveryCount + ' 次（最近 ' + clock(cmd.lastDeliveredAt) + '）' : ''
      })
    }
    ;(cmd.trail || []).forEach(function (t) {
      rows.push({ at: t.at, label: '过程：' + phaseLabel(t.phase), extra: t.percent !== undefined ? t.percent + '%' : '' })
    })
    if (cmd.progress && cmd.progress.updatedAt) {
      var lastTrail = cmd.trail && cmd.trail.length ? cmd.trail[cmd.trail.length - 1].at : null
      if (cmd.progress.updatedAt !== lastTrail) {
        rows.push({
          at: cmd.progress.updatedAt,
          label: '当前：' + phaseLabel(cmd.progress.phase),
          extra: (cmd.progress.percent !== undefined ? cmd.progress.percent + '%' : '') +
            (cmd.progress.message ? ' ' + cmd.progress.message : '')
        })
      }
    }
    if (cmd.finishedAt) {
      rows.push({
        at: cmd.finishedAt,
        label: cmd.state === 'success' ? '回执：成功' : cmd.state === 'failed' ? '回执：失败' : '结束：' + (STATE_LABEL[cmd.state] || cmd.state),
        extra: cmd.detail || ''
      })
    }
    var tlHtml = '<ol class="tl">' + rows.map(function (r) {
      return '<li class="tl__row">' +
        '<span class="tl__at">' + clock(r.at) + '</span>' +
        '<span class="tl__plus">+' + fmtDur(elapsedFrom(cmd, r.at)) + '</span>' +
        '<span class="tl__label">' + esc(r.label) + '</span>' +
        '<span class="tl__extra">' + esc(r.extra || '') + '</span>' +
        '</li>'
    }).join('') + '</ol>'

    el.procBody.innerHTML =
      '<div class="proc__head">' +
        chip(cmd.state) +
        '<span class="rid">' + esc(cmd.id) + '</span>' +
        '<span class="proc__rid">' + esc(cmd.releaseId || '') + '</span>' +
        '<span class="proc__dur">进度 ' + chain.states.filter(function (s) { return s === 'done' }).length + '/' + chain.states.length + '</span>' +
      '</div>' +
      stepsHtml +
      verdictHtml +
      tlHtml
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
          shortProgress(cmd) +
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
    var needToken = !state.token
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
    } else {
      el.tokenState.textContent = '未设置（下发会 401）'
      el.tokenState.className = 'tokstate tokstate--warn'
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

  // 复制设置链接：存成书签，换浏览器/换电脑时打开即自动写入 token
  if (el.copyLinkBtn) {
    el.copyLinkBtn.addEventListener('click', function () {
      if (!state.token) {
        notice('err', '还没有 Token：先在输入框填一次（或打开你的设置链接），再复制。')
        return
      }
      var link = settingsLink()
      copyText(link).then(function (ok) {
        notice(
          ok ? 'ok' : 'info',
          ok
            ? '设置链接已复制——存成浏览器书签即可：换浏览器/换电脑时打开它会自动写入 Token（片段不上行，不进服务器日志）。'
            : '复制失败，请手动复制：' + link
        )
      })
    })
  }
  if (el.dForce) el.dForce.addEventListener('change', renderResolved)

  el.sendBtn.addEventListener('click', function () {
    var deviceId = el.dDevice.value
    var releaseId = el.dRelease.value
    if (!deviceId || !releaseId) return
    dispatchCommand(deviceId, releaseId)
  })

  /** POST 真实接口（带 Bearer token）；失败按状态码给可操作提示 */
  function dispatchCommand(deviceId, releaseId) {
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

  // ══ 启动 ════════════════════════════════════════════════
  var fromLink = consumeTokenFromUrl()
  try { state.token = fromLink || localStorage.getItem(TOKEN_KEY) || '' } catch (e) { state.token = fromLink }
  if (el.dToken) el.dToken.value = state.token
  renderTokenState()
  state.selectedId = ''

  load().then(function () {
    // 连接失败/恢复由 load() 内的跃迁逻辑提示；这里只管启动期的引导
    if (fromLink) {
      notice('ok', '✅ Token 已从设置链接写入本机并记住——以后打开本页不用再填。')
    } else if (!state.lastError && state.devices.length === 0) {
      notice('info', '已连通，但暂无设备上报。设备端第一次 report 后就会出现在这里。')
    } else if (!state.lastError && !state.token) {
      notice('info', '下发是写操作，需要先在下方填 Token；上报与回执是免鉴权的。')
    }
  })
  state.timer = setInterval(load, POLL_MS)
  window.addEventListener('beforeunload', function () { clearInterval(state.timer) })
})()
