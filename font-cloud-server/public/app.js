/* Font Cloud 测试台 */
const $ = (sel) => document.querySelector(sel);

const state = {
  fonts: [],
  lastResult: null,
  timer: null,
};

// ---------- helpers ----------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(n) {
  return `${Number(n).toFixed(1)} ms`;
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

function uniqueChars(text) {
  const seen = new Set();
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  return res;
}

// ---------- chips / dedupe ----------
function renderChips() {
  const text = $("#chars-input").value || "";
  const chars = uniqueChars(text);
  const all = $("#char-chips");
  const miss = $("#missing-chips");
  all.innerHTML = "";
  miss.innerHTML = "";

  if (!chars.length) {
    all.innerHTML = `<span class="chip empty">无有效字符</span>`;
    miss.innerHTML = `<span class="chip empty">—</span>`;
    $("#dedupe-preview").textContent = "输入文本后将显示去重结果。";
    return;
  }

  for (const ch of chars) {
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = ch;
    all.appendChild(el);
  }
  for (const ch of chars) {
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = ch;
    miss.appendChild(el);
  }

  $("#dedupe-preview").textContent =
    `去重后 ${chars.length} 字（原文 ${[...text].length} 字符）→ 本轮一次请求：${chars.slice(0, 30).join("")}${chars.length > 30 ? "…" : ""}`;
}

// ---------- subset ----------
async function requestSubset() {
  const font = $("#font-select").value;
  const text = $("#chars-input").value || "";
  const include_latin = $("#include-latin").checked;
  const chars = uniqueChars(text);
  if (!font) {
    alert("请选择字体");
    return;
  }
  if (!chars.length) {
    alert("请输入至少一个有效字符");
    return;
  }

  const btn = $("#btn-subset");
  btn.disabled = true;
  btn.textContent = "请求中…";

  try {
    const res = await api("/api/subset", {
      method: "POST",
      body: JSON.stringify({ font, chars: chars.join(""), include_latin }),
    });
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength;
    const hit = res.headers.get("X-Cache-Hit") === "1";
    const ms = res.headers.get("X-Subset-Ms");
    const missing = res.headers.get("X-Subset-Missing") || "0";
    const key = res.headers.get("X-Cache-Key") || "";
    const uniqueCount = res.headers.get("X-Subset-Chars") || String(chars.length);
    const glyphs = res.headers.get("X-Subset-Glyphs") || "";
    const latin = res.headers.get("X-Latin-Included") === "1";

    const blob = new Blob([buf], { type: "font/ttf" });
    const url = URL.createObjectURL(blob);
    const old = state.lastResult?.url;
    if (old) URL.revokeObjectURL(old);

    state.lastResult = { url, bytes, hit, ms, missing, key, uniqueCount, font };

    // 结果面板
    $("#result-panel").hidden = false;
    $("#result-status").textContent = hit ? "缓存命中" : "实时子集化完成";
    $("#result-body").innerHTML = `
      <div class="stat-card ${hit ? "ok" : "info"}">
        <div class="lbl">缓存</div>
        <div class="val">${hit ? "HIT" : "MISS"}</div>
      </div>
      <div class="stat-card info">
        <div class="lbl">子集体积</div>
        <div class="val">${fmtBytes(bytes)}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">处理耗时</div>
        <div class="val">${fmtMs(ms)}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">请求字数</div>
        <div class="val">${uniqueCount}</div>
      </div>
      <div class="stat-card ${Number(missing) > 0 ? "warn" : ""}">
        <div class="lbl">字体缺字</div>
        <div class="val">${missing}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">全量字体</div>
        <div class="val">${fmtBytes((state.fonts.find((f) => f.id === font) || {}).bytes || 0)}</div>
      </div>
      <div class="stat-card">
        <div class="lbl">字形数</div>
        <div class="val">${glyphs || "—"}</div>
      </div>
      <div class="stat-card ${latin ? "ok" : ""}">
        <div class="lbl">拉丁字母</div>
        <div class="val">${latin ? "已带上" : "未带"}</div>
      </div>
    `;
    $("#dl-link").href = url;
    $("#dl-link").download = `${font}-${key || "subset"}.ttf`;
    $("#result-path").textContent = `cache key: ${key}`;

    await refreshStats();
  } catch (e) {
    alert(`请求失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "拉取子集字体";
  }
}

// ---------- stats ----------
function drawLineChart(canvas, values, color, label) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = "rgba(221,213,198,0.9)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = 12 + ((h - 32) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(36, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
  }

  if (!values.length) {
    ctx.fillStyle = "#5a6370";
    ctx.font = "12px sans-serif";
    ctx.fillText("暂无数据", 40, h / 2);
    return;
  }

  const max = Math.max(...values, 1);
  const min = 0;
  const padL = 36;
  const padR = 8;
  const padT = 12;
  const padB = 20;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  // y labels
  ctx.fillStyle = "#5a6370";
  ctx.font = "10px sans-serif";
  ctx.fillText(String(Math.round(max)), 4, padT + 4);
  ctx.fillText("0", 20, h - padB);

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = padL + (innerW * i) / Math.max(values.length - 1, 1);
    const y = padT + innerH - ((v - min) / (max - min)) * innerH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  values.forEach((v, i) => {
    const x = padL + (innerW * i) / Math.max(values.length - 1, 1);
    const y = padT + innerH - ((v - min) / (max - min)) * innerH;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  if (label) {
    ctx.fillStyle = "#5a6370";
    ctx.font = "10px sans-serif";
    ctx.fillText(label, padL, h - 4);
  }
}

function drawBarChart(canvas, values) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!values.length) {
    ctx.fillStyle = "#5a6370";
    ctx.font = "12px sans-serif";
    ctx.fillText("暂无数据", 40, h / 2);
    return;
  }

  const max = Math.max(...values, 1);
  const padL = 28;
  const padB = 18;
  const padT = 10;
  const innerW = w - padL - 8;
  const innerH = h - padT - padB;
  const gap = 4;
  const barW = Math.max(3, innerW / values.length - gap);

  values.forEach((v, i) => {
    const x = padL + i * (barW + gap);
    const bh = (v / max) * innerH;
    const y = padT + innerH - bh;
    ctx.fillStyle = i === values.length - 1 ? "#3b4fe4" : "#9aa8ff";
    ctx.fillRect(x, y, barW, bh);
  });

  ctx.fillStyle = "#5a6370";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${max.toFixed(1)} KB`, 4, padT + 8);
  ctx.fillText("最近子集", padL, h - 4);
}

function renderStats(s) {
  $("#k-req").textContent = s.subset_requests;
  $("#k-hit").textContent = `${(s.cache_hit_rate * 100).toFixed(1)}%`;
  $("#k-lat").textContent = fmtMs(s.latency_ms.avg);
  $("#k-bytes").textContent = fmtBytes(s.bytes_out);
  $("#k-size").textContent = fmtBytes(s.subset_bytes.avg);
  $("#k-chars").textContent = s.unique_chars_ever;

  const hist = s.history || state.hist || [];
  // history is separate; keep last 24 from stats history if present
  drawLineChart($("#chart-latency"), state.latSeries, "#3b4fe4", "ms");
  drawBarChart(
    $("#chart-size"),
    state.sizeSeries.map((v) => v / 1024)
  );

  const tbody = $("#font-table tbody");
  tbody.innerHTML = "";
  const fonts = s.per_font || {};
  const entries = Object.entries(fonts);
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#5a6370">尚无请求</td></tr>`;
  } else {
    for (const [fid, v] of entries) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${fid}</strong></td>
        <td>${v.requests}</td>
        <td>${v.cache_hits}</td>
        <td>${v.chars}</td>
        <td>${fmtBytes(v.bytes_out)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  const c = s.cache || {};
  $("#cache-box").innerHTML = `
    <div class="kv"><span class="k">条目</span><span class="v">${c.entries ?? 0}</span></div>
    <div class="kv"><span class="k">占用</span><span class="v">${fmtBytes(c.bytes || 0)}</span></div>
    <div class="kv"><span class="k">命中 / 未命中</span><span class="v">${s.cache_hits} / ${s.cache_misses}</span></div>
    <div class="kv"><span class="k">错误</span><span class="v">${s.errors}</span></div>
    <div class="kv"><span class="k">运行</span><span class="v">${Math.round(s.uptime_sec)}s</span></div>
  `;
  $("#lat-box").innerHTML = `
    <div class="kv"><span class="k">p50</span><span class="v">${fmtMs(s.latency_ms.p50)}</span></div>
    <div class="kv"><span class="k">p95</span><span class="v">${fmtMs(s.latency_ms.p95)}</span></div>
    <div class="kv"><span class="k">max</span><span class="v">${fmtMs(s.latency_ms.max)}</span></div>
    <div class="kv"><span class="k">样本</span><span class="v">${s.latency_ms.samples}</span></div>
    <div class="kv"><span class="k">子集 min/max</span><span class="v">${fmtBytes(s.subset_bytes.min)} / ${fmtBytes(s.subset_bytes.max)}</span></div>
  `;
}

function renderHistory(list) {
  const tbody = $("#hist-table tbody");
  tbody.innerHTML = "";
  $("#hist-count").textContent = `${list.length} 条`;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#5a6370">暂无请求</td></tr>`;
    return;
  }
  for (const r of list.slice(0, 40)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtTime(r.ts)}</td>
      <td>${r.font}</td>
      <td>${r.unique_count}</td>
      <td>${(r.missing || "").length ? r.missing.length : "—"}</td>
      <td class="${r.cache_hit ? "hit" : "miss"}">${r.cache_hit ? "HIT" : "MISS"}</td>
      <td>${fmtBytes(r.bytes)}</td>
      <td>${fmtMs(r.ms)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function buildSeries(history) {
  const rev = [...history].reverse();
  state.latSeries = rev.map((r) => r.ms).slice(-40);
  state.sizeSeries = rev.map((r) => r.bytes).slice(-24);
}

async function refreshStats() {
  const [sRes, hRes] = await Promise.all([
    api("/api/stats"),
    api("/api/stats/history"),
  ]);
  const stats = await sRes.json();
  const hist = (await hRes.json()).history || [];
  state.hist = hist;
  buildSeries(hist);
  renderStats({ ...stats, history: hist });
  renderHistory(hist);
}

async function loadFonts() {
  const res = await api("/api/fonts");
  const data = await res.json();
  state.fonts = data.fonts || [];
  const sel = $("#font-select");
  sel.innerHTML = "";
  for (const f of state.fonts) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = `${f.name}  (${fmtBytes(f.bytes)}, ${f.glyph_count} glyphs)`;
    sel.appendChild(opt);
  }
  // 优先 MiSans
  const preferred = state.fonts.find((f) => f.id.includes("misans"));
  if (preferred) sel.value = preferred.id;
}

async function checkHealth() {
  const el = $("#health");
  try {
    const res = await api("/health");
    const j = await res.json();
    el.textContent = `online · v${j.proto}`;
    el.classList.remove("bad");
  } catch (e) {
    el.textContent = "offline";
    el.classList.add("bad");
  }
}

// ---------- events ----------
function bind() {
  $("#chars-input").addEventListener("input", renderChips);
  $("#btn-subset").addEventListener("click", requestSubset);
  $("#btn-clear").addEventListener("click", () => {
    $("#chars-input").value = "";
    renderChips();
    $("#result-panel").hidden = true;
  });
  $("#btn-demo").addEventListener("click", () => {
    $("#chars-input").value =
      "天青色等烟雨而我在等你\n炊烟袅袅升起隔江千万里\n在瓶底书汉隶仿前朝的飘逸";
    renderChips();
  });
  $("#btn-refresh").addEventListener("click", async () => {
    await checkHealth();
    await refreshStats();
  });
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("确定清空服务端统计与计数？（不影响已缓存字体文件）")) return;
    await api("/api/stats/reset", { method: "POST", body: "{}" });
    await refreshStats();
  });

  state.timer = setInterval(async () => {
    try {
      await refreshStats();
    } catch (_) {}
  }, 3000);
}

async function boot() {
  state.latSeries = [];
  state.sizeSeries = [];
  bind();
  renderChips();
  await checkHealth();
  await loadFonts();
  await refreshStats();
}

boot();
