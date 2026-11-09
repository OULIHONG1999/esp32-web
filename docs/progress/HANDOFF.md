# HANDOFF — 换电脑继续开发交接指南

> 2026-10-25 · 面向：在新电脑上 clone 本仓库并继续开发的工程师/AI
> 配合阅读：根目录 `PROGRESS.md`（当前状态）→ `AGENTS.md`（纪律）→ `docs/progress/decisions.md`（坑）→ 本文（环境与本地重建）。
> 仓库：`https://github.com/OULIHONG1999/esp32-web.git` · 分支 `master`

---

## 0. 三分钟恢复开发（最小路径）

```powershell
# 1) clone（若 GitHub 直连超时，先开系统代理 127.0.0.1:7890，见 §4）
git clone https://github.com/OULIHONG1999/esp32-web.git
cd esp32-web

# 2) Node ≥ 24（CI 用 24；本机开发不要用 TS7，typescript 已锁 5.9）
node --version   # 期望 v24.x

# 3) 依赖 + 验证（全绿才算环境就绪）
npm install
npm test         # Vitest，23 文件 · 392+ 用例
npm run build    # vue-tsc --noEmit && vite build

# 4) 起本地服务（可选，localhost 即安全上下文，Web Serial 可用）
$env:PORT = "8787"
$env:FIRMWARE_PUBLISH_TOKEN = "<随便一个强随机串，仅本地发布测试用>"
node server/index.js
# 浏览器打开 http://localhost:8787
```

> **本仓库无 MIMO_NODE 依赖**：`& $env:MIMO_NODE $env:MIMO_NPM ...` 是旧机器 MiMo Desktop 打包运行时的用法（旧机 Node 不在 PATH）。新机器只要 Node ≥ 24 在 PATH，直接 `npm` / `node` 即可。CI（`.github/workflows/ci.yml`）也用标准 `npm install && npm test && npm run build`。

---

## 1. 仓库里有什么 / 没有什么

### 1.1 已入库（clone 即得）

| 内容 | 说明 |
|---|---|
| `src/` | 前端：core（纯逻辑）/ glue（esptool-js 粘合）/ components / composables |
| `server/` | v1.5 自含服务（纯 JS 零依赖 `node:http`） |
| `tools/publish/` | 发布/推送 CLI（once / watch / promote / push） |
| `tools/balance_gateway/` | 余额网关子项目（**凭证文件不入库**，见 §2.3） |
| `tools/package-deploy.ps1` | 发布打包（占位符→真实地址；真实地址不入库） |
| `public/` | 静态页（OTA/coredump/drive/设备模拟器/docs 镜像） |
| `docs/` | 现行文档（USER-GUIDE/DESIGN/REQUIREMENTS/DEPLOY/…） |
| `tests/` | Vitest 全套 + fixtures |
| `.github/workflows/ci.yml` | push/PR 触发：Node 24 · install · test · build |
| `.gitignore` | 见 §1.2 |

### 1.2 不入库（新机器必须自行重建，见 §2）

```
node_modules/  dist/  server-data/  .env*  *.local
.fw-deploy.local                          # 真实服务器地址（部署打包用）
tools/balance_gateway/config.json         # 网关凭证
tools/balance_gateway/session.json        # 浏览器会话
font-cloud-server/.venv/  cache/  data/  fonts/*.ttf|otf|ttc
*.log  __pycache__/  deploy-package.zip
```

### 1.3 ⚠️ 文档说"进 git"但当前仓库没有的文件

| 文件 | 状态 | 新机器怎么办 |
|---|---|---|
| `publish.config.json`（工程根） | **未入库**（只有 `tests/fixtures/` 测试样本） | 按 `docs/PUBLISH.md` §1 模板自建；`token` 用 `"${FIRMWARE_PUBLISH_TOKEN}"` 环境变量引用，**不要提交明文 token** |

---

## 2. 新机器本地重建清单

按需做——只开发前端/跑测试的话 §0 就够；要发布/部署/网关再往下。

### 2.1 发布固件（publish）

1. 工程根创建 `publish.config.json`（模板：`docs/PUBLISH.md` §1）：
   - `server`：真实服务地址（见 §2.2 如何取）
   - `token`：`"${FIRMWARE_PUBLISH_TOKEN}"`
   - `project` / `buildDir` 按目标固件项目填写
2. 设置环境变量（值 = 服务器 `/etc/firmware-server.env` 里的 `FIRMWARE_PUBLISH_TOKEN`，或页面 🔑 生成的 `wk_` 工作 token）：
   ```powershell
   $env:FIRMWARE_PUBLISH_TOKEN = "<64位hex或wk_...>"
   ```
3. 发布：
   ```powershell
   node tools/publish/index.js once --config publish.config.json
   ```
   ⚠️ `--watch` 后台网络失败未定位（decisions 问题 20）——**发布一律手动 once**。

### 2.2 部署到云服务器（package-deploy）

真实服务器地址**只存在本机** `.fw-deploy.local`（gitignored，绝不入库）。新机器二选一：

```powershell
# 方案 A：从旧电脑拷贝该文件到仓库根，格式两行：
#   SERVER_HOST=<真实地址>
#   PANEL_HOST=<面板域名，可选，默认=SERVER_HOST>

# 方案 B：不拷贝，打包时显式传参
powershell -File tools/package-deploy.ps1 -ServerHost <真实地址> [-PanelHost <域名>]
```

完整部署流程（scp → unzip → systemctl restart → 核对）见 `AGENTS.md` 纪律 9 与 `docs/DEPLOY.md` / `docs/SERVER.md`。

### 2.3 balance_gateway（可选子项目）

- 入口：`tools/balance_gateway/README.md`（唯一入口，自包含）
- 需自建且已 gitignore：`config.json`（凭证）、`session.json`（运行时生成）
- 云部署/实机验证截至 2026-10-25 **尚未做**（README §14）

### 2.4 font-cloud-server（可选）

- `.venv/`、`cache/`、`data/`、大字体文件均不入库；按 `font-cloud-server` 内说明重建
- 部署：`powershell -File font-cloud-server/deploy/deploy.ps1`（AGENTS 纪律 10）

### 2.5 实机烧录前置

- 浏览器需 **HTTPS 或 localhost**（Web Serial 安全上下文）
- Chrome/Edge；Safari 不支持（明确不做）
- ESP32-S3 原生 USB / USB-Serial-JTAG 驱动正常

---

## 3. 开发日常命令

```powershell
npm install          # 首次 / lock 变更后
npm test             # Vitest 全绿（提交前必须）
npm run build        # vue-tsc + vite build（提交前必须）
npm run typecheck    # 仅类型检查
npm run dev          # vite dev（5173）；完整启动配方见 PROGRESS「关键决策 4」
npm run server       # 起自含服务（需先 build 或仅用 API）
```

提交纪律（详见 `AGENTS.md`）：

1. 提交信息用**中文**，正文引用对应 `F-xx` 验收项
2. 改状态机迁移表 → 同步 `docs/DESIGN.md` §4.1 + `tests/device.test.ts`
3. 改错误文案 → 同步 `docs/DESIGN.md` §4.4 + `tests/errors.test.ts`
4. 改文档改 `docs/` 源头；**公网文档需同步拷贝到 `public/docs/`**；`docs/progress/` 与 `PROGRESS.md` 不挂公网
5. 完成定义：代码进层 + 测试全绿 + PROGRESS 更新 + F-xx 打勾
6. 自动发布授权仍然有效（纪律 9/10）：全绿并提交后直接发布，不再询问

---

## 4. 网络与代理（GitHub 访问）

本机实测：**直连 `github.com:443` 超时**，系统代理 `127.0.0.1:7890`（Clash 类）可通。新机器若同样超时：

```powershell
# 仅当前会话
$env:HTTP_PROXY  = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
git fetch / git push

# 或持久化到 git 配置
git config --global http.proxy  http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

代理端口以新机器实际为准；不要把代理配置提交进仓库。

---

## 5. 首日建议动线

1. clone → `npm install` → `npm test` → `npm run build`（确认 CI 同款全绿）
2. 读 `PROGRESS.md` 当前状态与下一步 → `docs/progress/decisions.md` 坑 1–24
3. 打开 `README.md` 一页纸过一遍架构
4. 需要真机时：`npm run server` + localhost 页面连板验证
5. 需要发布/部署时：按 §2 补齐本地文件
6. 确认远端最新：`git log origin/master -5` 与 PROGRESS「最后更新」一致

---

## 6. 当前未完成事项（接手即续）

见 `PROGRESS.md`「下一步」，摘要：

1. 持续体验优化（进行中）
2. backlog：watch 网络失败 / flash_args 参数生效性 / 硬复位按钮
3. 设备端（另一台电脑）：push 进度上报、coredump 上传方 → `docs/DEVICE-OTA.md`
4. S5 页面补充上传：按需不排期
5. 等用户拍板：主操作按钮方案
6. balance_gateway 云部署与实机验证

---

## 7. 故障速查

| 症状 | 先查 |
|---|---|
| `npm test` 失败 | `docs/progress/decisions.md` 对应坑号；勿回退 vitest include（须含 `*.{ts,js}`） |
| `npm run build` 报 vue-tsc | typescript 是否被升到 7（必须锁 5.9）；esptool-js 是否被升（必须锁 0.7.0） |
| git push 超时 | §4 代理 |
| 发布 `fetch failed` | 手动 `once`，别用 watch（问题 20） |
| 打包 zip 是旧产物 | 先 `npm run build`；`package-deploy.ps1` 有新鲜度自检 |
| 烧录"卡在一半" | decisions 问题 24：进度换算 + Transport tracing 必须 false |
| 连接被拒/自锁 | decisions 问题 22：Web Locks 回调内判定 |
