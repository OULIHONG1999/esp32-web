/* 云盘 — 页面逻辑（零依赖、独立页）
 *
 * 数据全部来自服务器实时接口，**无本地假数据**：
 *   GET    /api/drive/files               列表（含每文件 url）
 *   POST   /api/drive/files               上传（Bearer；multipart file+note）
 *   DELETE /api/drive/files/{fileId}      删除（Bearer；幂等）
 *   下载走 <a href=url download>，无需 token
 *
 * 契约依据：/docs/cloud-drive.md §4；机器描述符：/drive.json。
 * 写操作（上传/删除）需 Bearer token，存 localStorage `fw.token`（与主站/OTA 共用同一键，不上传）。
 */
;(function () {
  'use strict'

  var POLL_MS = 5000
  var TOKEN_KEY = 'fw.token'
  var $ = function (id) { return document.getElementById(id) }
  var el = {
    tokenInput: $('tokenInput'),
    refreshBtn: $('refreshBtn'),
    fileInput: $('fileInput'),
    noteInput: $('noteInput'),
    uploadBtn: $('uploadBtn'),
    uploadMsg: $('uploadMsg'),
    fTotal: $('fTotal'), fBytes: $('fBytes'), fLast: $('fLast'), connState: $('connState'),
    pollLabel: $('pollLabel'), lastRefresh: $('lastRefresh'),
    listBody: $('listBody'), listEmpty: $('listEmpty'),
  }
  var state = { files: [], totalBytes: 0, timer: null }

  // ── 工具 ────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtBytes(n) {
    if (n == null) return '—'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
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

  function getToken() { return localStorage.getItem(TOKEN_KEY) || '' }

  /** 打开 /drive#token=xxx 即写本机并抹掉片段（片段不上行 → 不进日志） */
  function applyHashToken() {
    var m = /token=([^&]+)/.exec(location.hash)
    if (m) {
      localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]))
      history.replaceState(null, '', location.pathname + location.search)
    }
  }

  function setMsg(text, kind) {
    if (!text) { el.uploadMsg.hidden = true; el.uploadMsg.textContent = ''; return }
    el.uploadMsg.hidden = false
    el.uploadMsg.textContent = text
    el.uploadMsg.className = 'upload-msg ' + (kind || '')
  }

  // ── 数据加载 ────────────────────────────────────────────
  function load() {
    fetch('/api/drive/files').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }).then(function (json) {
      state.files = json.files || []
      state.totalBytes = (json._meta && json._meta.totalBytes) || 0
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
    el.fTotal.textContent = state.files.length
    el.fBytes.textContent = fmtBytes(state.totalBytes)
    el.fLast.textContent = state.files.length ? timeAgo(state.files[0].createdAt) : '—'
    el.lastRefresh.textContent = new Date().toLocaleTimeString()
    el.listEmpty.hidden = state.files.length > 0
    el.listBody.innerHTML = state.files.map(cardHtml).join('')
  }

  function cardHtml(f) {
    return (
      '<div class="file" data-id="' + esc(f.fileId) + '">' +
        '<div class="file__bar"></div>' +
        '<div class="file__main">' +
          '<div class="file__name">' + esc(f.name) + '</div>' +
          (f.note ? '<div class="file__note">' + esc(f.note) + '</div>' : '') +
          '<div class="file__meta">' +
            '<span class="tag">' + esc(f.fileId) + '</span>' +
            '<span class="tag">' + fmtBytes(f.size) + '</span>' +
            '<span class="tag">' + timeAgo(f.createdAt) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="file__ops">' +
          '<a class="btn" href="' + esc(f.url) + '" download>下载</a>' +
          '<button class="btn btn--danger" data-action="del" data-id="' + esc(f.fileId) + '">删除</button>' +
        '</div>' +
      '</div>'
    )
  }

  // ── 上传 / 删除 ─────────────────────────────────────────
  function upload() {
    var file = el.fileInput.files[0]
    if (!file) { setMsg('请先选择文件', 'err'); return }
    var token = getToken()
    if (!token) { setMsg('需要 Bearer token：上方输入，或打开 /drive#token=xxx 设置', 'err'); return }
    var fd = new FormData()
    fd.append('file', file)
    var note = el.noteInput.value.trim()
    if (note) fd.append('note', note)

    setMsg('上传中…')
    fetch('/api/drive/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: fd,
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } })
    }).then(function (r) {
      if (!r.ok) {
        var hint = r.status === 401 ? 'token 无效或过期' : r.status === 413 ? '超出大小/配额限制' : (r.json && r.json.error) || ('HTTP ' + r.status)
        setMsg('上传失败：' + hint, 'err')
        return
      }
      setMsg('已上传 ' + r.json.file.name + '（' + fmtBytes(r.json.file.size) + '）', 'ok')
      el.fileInput.value = ''
      el.noteInput.value = ''
      load()
    }).catch(function () { setMsg('上传失败：网络错误', 'err') })
  }

  function del(fileId) {
    var token = getToken()
    if (!token) { setMsg('需要 Bearer token 才能删除', 'err'); return }
    if (!window.confirm('删除该文件？此操作不可恢复。')) return
    fetch('/api/drive/files/' + fileId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    }).then(function (res) {
      return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json } })
    }).then(function (r) {
      if (!r.ok) { setMsg('删除失败：' + ((r.json && r.json.error) || ('HTTP ' + r.status)), 'err'); return }
      setMsg('已删除', 'ok')
      load()
    }).catch(function () { setMsg('删除失败：网络错误', 'err') })
  }

  // ── 事件 ────────────────────────────────────────────────
  el.listBody.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="del"]')
    if (!btn) return
    del(btn.getAttribute('data-id'))
  })
  el.uploadBtn.addEventListener('click', upload)
  el.refreshBtn.addEventListener('click', load)
  el.tokenInput.addEventListener('change', function () {
    localStorage.setItem(TOKEN_KEY, el.tokenInput.value.trim())
  })

  // ── 启动 ────────────────────────────────────────────────
  applyHashToken()
  el.tokenInput.value = getToken()
  el.pollLabel.textContent = (POLL_MS / 1000) + 's'
  load()
  state.timer = setInterval(load, POLL_MS)
})()
