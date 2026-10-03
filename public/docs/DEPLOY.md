# DEPLOY — Ubuntu 部署 Runbook（S2 · 门3 交付物）

> 2026-09-29 · 关联：EXECUTION-PLAN.md（S2）、FIRMWARE-REGISTRY.md §0
> **当前实际部署的状态快照见 `SERVER.md`**（拓扑/通道/token/运维命令），本文是通用部署手册。
> 目标：自含服务上 Ubuntu（registry + 发布 + SSE + 静态前端），零第三方运行时依赖。
> 两种反代方案：**Caddy（推荐，自动 HTTPS）** 与 nginx（已有站点时用），SSE 缓冲配置都必须写对。

## 0. 前置

| 项 | 要求 |
|---|---|
| OS | Ubuntu 22.04+（其它发行版仅 systemd/caddy 命令名不同） |
| Node | **≥ 24**（原生 fetch/FormData；`node --version` 确认） <br> 没有则：`curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt install -y nodejs` |
| 域名 | 推荐有域名（Caddy 自动签证书）；只有 IP 也能跑（浏览器 Web Serial 要 HTTPS 或 localhost——**访问方是本地浏览器**，见 §5 说明） |
| 端口 | 8787（服务，仅本机监听）+ 80/443（反代） |

## 0.5 快速路径：本机 5 分钟体验版（localhost 即安全上下文）

适合「先跑起来看看 / 单人本机用」——无需 nginx/证书/域名：

```powershell
# 1) 依赖与构建（Node >= 24）
npm install
npm run build

# 2) 起服务（自含零依赖；默认 8787，静态托管 dist/）
$env:PORT = "8787"
$env:FIRMWARE_PUBLISH_TOKEN = "<随便一个强随机串，发布端要用>"
node server/index.js

# 3) 浏览器打开（localhost 是安全上下文，Web Serial 可用）
#    http://localhost:8787
```

本机发布固件测试：把 `PUBLISH.md` 的 server 地址改为 `http://localhost:8787`、token 用上面设置的值即可。
需要外网/多设备/HTTPS 时，再走下面的完整部署（§1 起）。

---

## 1. 部署产物（本地构建后上传）

```powershell
# 本地 Windows（本项目根）
& $env:MIMO_NODE $env:MIMO_NPM run build        # 产出 dist/
# 上传到服务器（示例用 rsync/scp，目标 /opt/firmware-server）
# 需上传：server/  dist/  package.json（仅 scripts 便于 npm run）
```

服务器目标结构：

```
/opt/firmware-server/
├── server/            # 自含服务（零依赖）
├── dist/              # 前端构建产物
├── package.json       # 可选（npm run server 便捷入口）
└── server-data/       # 运行时数据（registry.json + projects/）——不上传，自动创建
```

```bash
sudo useradd -r -s /usr/sbin/nologin fwserver || true
sudo mkdir -p /opt/firmware-server && sudo chown -R $USER /opt/firmware-server
# （上传文件后）
sudo chown -R fwserver /opt/firmware-server/server-data 2>/dev/null || true
```

## 2. Token

```bash
TOKEN=$(openssl rand -hex 32)
echo "FIRMWARE_PUBLISH_TOKEN=$TOKEN" | sudo tee /etc/firmware-server.env
sudo chmod 600 /etc/firmware-server.env
# 把同一个 token 写进远端 Windows 的环境变量（publish.config.json 引用 ${FIRMWARE_PUBLISH_TOKEN}）
```

## 3. systemd 服务

`/etc/systemd/system/firmware-server.service`：

```ini
[Unit]
Description=Firmware Registry Server (esp32-web)
After=network.target

[Service]
Type=simple
User=fwserver
WorkingDirectory=/opt/firmware-server
EnvironmentFile=/etc/firmware-server.env
Environment=PORT=8787
# 默认监听 127.0.0.1 由反代兜底；如需直连改 node server/index.js 内 listen 或加 --host（暂不改代码，见 §5）
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now firmware-server
systemctl status firmware-server --no-pager
curl -s http://127.0.0.1:8787/api/registry   # 期望 {"projects":{}}
```

## 4. 反代

### 4a. Caddy（推荐：自动 HTTPS + SSE 反缓冲）

`/etc/caddy/Caddyfile`：

```
firmware.example.com {
    # SSE 需要：禁缓冲/禁代理缓冲，否则 /api/registry/stream 事件会被攒批
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1          # 立即刷新响应（SSE 关键）
        transport http {
            read_timeout 3600s     # 长连接
        }
    }
}
```

```bash
sudo apt install -y caddy
sudo systemctl reload caddy
```

### 4b. nginx 备选

```nginx
server {
    listen 443 ssl http2;
    server_name firmware.example.com;
    # ssl_certificate ...（certbot --nginx 自动办）

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_buffering off;          # SSE 关键
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 256m;    # 发布上传上限（服务端自身限 256MB）
    }
}
```

## 5. 访问与 HTTPS 说明（Web Serial 硬约束）

- 浏览器烧录页要求**安全上下文**：`https://` 或 `localhost`。
- 本地浏览器访问远端服务器 → **必须 HTTPS**（Caddy 方案自动解决）。
- 无域名的临时办法：SSH 隧道把远端 8787 映射到本机 localhost——
  `ssh -N -L 8787:127.0.0.1:8787 user@server`，浏览器开 `http://localhost:8787`（localhost 是安全上下文）。
- 服务只监听 127.0.0.1 由反代终结 TLS（当前 `server.listen(port)` 默认绑定全接口——若要收紧，加环境变量 HOST 支持属后续小改）。

## 6. 远端 Windows 发布端

```powershell
# publish.config.json（工程根，进 git）
{
  "server": "https://firmware.example.com",
  "token": "${FIRMWARE_PUBLISH_TOKEN}",
  "project": { "id": "hello-world", "name": "Hello World" }
}

$env:FIRMWARE_PUBLISH_TOKEN = "<与服务器一致>"
node tools/publish once --config publish.config.json          # 手动单发
node tools/publish --watch --config publish.config.json       # 挂机自动发布（防抖 5s，失败退避重试）
```

长期挂机（任选）：
- 任务计划程序：登录时启动 `node tools/publish --watch --config ...`；
- 或 NSSM 把它注册成 Windows 服务。

**watch 语义**：盯发布输入（flash_args + 产物 + project_description + config.assets），签名变化防抖 5s 自动发布；网络失败重试 3 次（1s/2s/4s）仍失败则保留 pending 下轮补传；增量按 sha 跨 release 复用（未变文件不重传）。

## 7. 验证清单（门3 本地侧）

```bash
curl -s https://firmware.example.com/api/registry | head -c 200   # 200 + JSON
# 远端 Windows：publish once 成功
curl -s https://firmware.example.com/api/registry | grep hello-world
# 本地浏览器打开 https://firmware.example.com → 项目库刷新 → 出现新版本 → 载入
```

- [ ] 服务 systemd 常驻、重启自拉
- [ ] HTTPS 有效、页面环境自检通过
- [ ] 远端 `publish once` / `--watch` 成功、增量生效（二次发布只传变化文件）
- [ ] 本地页面项目库看到新版本并可载入（烧录核对暂缓——随 D4 一并）

## 8. 运维

```bash
# registry 自愈（损坏/丢失时）
cd /opt/firmware-server && sudo -u fwserver node server/rebuild.js
# ⚠️ rebuild 从各 Release 的 .meta.json 重建版本树——project 级字段
#    （★订阅 subscribed、retention 策略、description）会丢失；
#    重要时先备份：cp server-data/registry.json /tmp/ && rebuild && 对照恢复
# 数据备份（整个目录即全部状态）
sudo tar czf firmware-server-data.tgz /opt/firmware-server/server-data
# 磁盘检查
du -sh /opt/firmware-server/server-data
# 日志
journalctl -u firmware-server -f
```

- retention（自动清理旧 snapshot）在 S4 落地前：手工删 release 目录后跑 `rebuild.js`。
- token 泄露处置：换 `/etc/firmware-server.env` → `systemctl restart firmware-server` → 远端换环境变量。

## 9. SSE（S3 预留）

端点 `GET /api/registry/stream` **已实现（S3，门4 过）**；反代的 `flush_interval -1` / `proxy_buffering off` 必须配好，SSE 才能即时推送（响应头 `X-Accel-Buffering: no` 是服务端侧的双保险，nginx 读到会动态关闭该响应缓冲）。客户端同时有 30s 轮询降级，反代配错不会导致完全不可用，只会推送延迟。

## 10. 站点结构（build 产物随 dist 部署）

```
dist/
├── index.html            # 前端（含 AI 元数据 meta/JSON-LD/#ai-data）
├── assets/               # JS/CSS bundle
├── llms.txt              # AI 速查（API/数据结构/认证/文档索引）
├── docs/                 # 详细文档站（源文件在 public/docs/）
│   ├── PUBLISH.md        #   发布操作指南（含裸 HTTP curl 示例）
│   ├── DEPLOY.md         #   本手册
│   ├── FIRMWARE-REGISTRY.md / REQUIREMENTS.md / SERVER.md
└── tools/publish/        # CLI 源码托管（index/once/lib/watch 四文件，零依赖可下载）
```

⚠️ **维护纪律**：`public/` 下的文件才是构建源头（vite build 会清空 dist 再拷入 public）——**改文档改根目录/public 的源文件，绝不要只改服务器上的 dist**。

## 11. 双通道访问（本项目实际采用）

| 通道 | 用途 | 说明 |
|---|---|---|
| `https://<IP>/`（443） | 浏览器（Web Serial 必须安全上下文） | 自签证书 `CN=<IP>`，浏览器信任一次 |
| `http://<IP>/`（80） | **AI/爬虫只读**（llms.txt/docs/tools/registry） | 明文——token 相关写操作勿走此通道传秘密；配置见 nginx `firmware-server.conf`（`listen 80` + server_name=IP，不影响域名站点） |
