# SERVER — 当前部署状态详解（快照）

> 2026-09-29 快照 · 与通用手册 `DEPLOY.md` 互补：本文记录**这台服务器现在实际是什么样**
> 变更后请同步更新本文（下次改动时）

## 1. 拓扑总览

```
【你的 Windows build 机】                     【腾讯云 Ubuntu 22.04】
  publish once / CLI（明文 token 或 env）        firmware.example.com（域名 panel.example.com 亦解析到此）
        │ HTTPS POST /api/publish                     │
        ▼                                             ▼
  跨网设备 AI ──http://IP（只读学习）──▶ nginx（宝塔） ──proxy──▶ node firmware-server :8787
  本地浏览器 ──https://IP:443（自签）──▶                │            （systemd 常驻）
  本地浏览器 ──SSE /api/registry/stream ◀───────────────┤            └─▶ server-data/（磁盘数据）
                                                     └─proxy──▶ python font-cloud :8788（字体子集化，共存）
```

## 2. 服务器环境

| 项 | 值 |
|---|---|
| OS | Ubuntu 22.04.4 LTS（x86_64），root 直管 |
| Node | **v24.21.0**（NodeSource 安装） |
| 反代 | **宝塔 nginx**（`/www/server/nginx`，`nginx -s reload` 重载；apt 的 systemd nginx 未启用勿用） |
| 应用 | systemd `firmware-server`（`Restart=always`，EnvironmentFile=`/etc/firmware-server.env`） |
| 代码/数据 | `/opt/firmware-server/`：`server/` `dist/` `server-data/` |
| 部署方式 | 本机 `Compress-Archive` 打 zip → `scp` 免密 → `unzip -o` → `systemctl restart firmware-server` |
| SSH | 本机 `id_ed25519` 免密（密码认证曾异常，已弃用）；key 在 `~/.ssh/authorized_keys` |

## 3. 访问通道

| URL | 端口/协议 | 用途 | 证书/信任 |
|---|---|---|---|
| `https://firmware.example.com/` | 443 TLS | 浏览器主入口（Web Serial 需安全上下文） | **自签** `CN=firmware.example.com`（`/etc/ssl/certs/firmware-server.crt`），浏览器信任一次 |
| `http://firmware.example.com/` | 80 明文 | **AI/爬虫只读通道**（文档/源码/registry） | 无——秘密勿走此通道 |
| `/llms.txt` | 同上 | AI 速查（API/数据结构/认证/文档索引） | 公开 |
| `/docs/*.md` | 同上 | 详细文档站（PUBLISH/DEPLOY/FIRMWARE-REGISTRY/REQUIREMENTS/SERVER） | 公开 |
| `/tools/publish/*.js` | 同上 | 发布 CLI 源码下载（4 文件，零依赖） | 公开 |
| `/api/registry*` 等 | 同上 | 读接口公开；写接口需 Bearer | 见 §4 |

nginx 配置：`/www/server/panel/vhost/nginx/firmware-server.conf`（备份 `.conf.bak`）——
`server_name firmware.example.com` 同时 `listen 80` + `listen 443 ssl`，proxy 至 `127.0.0.1:8787`；
**域名站点 `www.panel.example.com` 是另一独立 server 块，互不影响**。

## 4. Token（发布/晋升/回滚/保留策略的写权限）

| 项 | 位置/说明 |
|---|---|
| 主 token（master） | **不落任何文档**——见服务器 `/etc/firmware-server.env` 的 `FIRMWARE_PUBLISH_TOKEN`，或向运维者索取（曾于 2026-09-29 公网泄露后**已轮换**，旧值作废） |
| 工作 token（`wk_` 前缀） | 页面 🔑「生成」产生（用主 token 换），持久化 `server-data/tokens.json`——**交给 AI/发布设备用**，可随时撤销 |
| 接口 | `POST/GET/DELETE /api/token`（**仅主 token** 鉴权）；写业务接口接受主或任一有效工作 token |
| 页面配置 | 右上角 🔑：生成（输主 token 换 wk_）或手动设置本机（localStorage `fw.token`） |
| 轮换 | 主 token：改 env → `systemctl restart firmware-server`（泄露时必须轮换）；工作 token：撤销即可，无需重启 |
| 撤销示例 | `curl -X DELETE https://IP/api/token -H "Authorization: Bearer <主token>" -d '{"token":"wk_..."}'` |

> ⚠️ 安全纪律：**任何 token 明文不得写入本仓库文档**（仓库文档会挂公网 `/docs/`）；秘密只存服务器 env 与本地安全位置。

## 5. 数据与运维

```bash
# 状态/日志
systemctl status firmware-server
journalctl -u firmware-server -f
systemctl show firmware-server -p ExecMainStartTimestamp --value   # ⚠️ 部署后必查：时间戳没变=没加载新代码

# 数据（全部状态在 server-data/：registry.json + projects/）
du -sh /opt/firmware-server/server-data
tar czf /tmp/fw-data.tgz -C /opt/firmware-server server-data        # 备份

# registry 自愈（详见 DEPLOY §8：会丢 project 级 subscribed/retention，先备份）
node server/rebuild.js

# 部署新版本（本机执行）
# 1) npm run build   2) Compress-Archive server,dist,package.json → zip
# 3) scp zip root@IP:/opt/firmware-server/   4) ssh: unzip -o + systemctl restart
# 5) 核对 ExecMainStartTimestamp 已刷新 + curl 关键端点
```

**已实测的运维记录**：
- registry 重建实测（删→rebuild：1 项目/10 版本一致→恢复备份）
- SSE 经 nginx 实测无缓冲（`X-Accel-Buffering: no` 生效）
- 写接口 401 鉴权实测生效

## 5.5 共存服务 font-cloud（2026-10-04 起）

| 项 | 值 |
|---|---|
| 用途 | 字体云端子集化（动态文本缺字 → 子集 TTF），与 firmware-server 同机共存 |
| 服务 | systemd `font-cloud-server`（`/opt/font-cloud-server`，Python3.10 venv + fontTools） |
| 端口 | **8788**（仅本机 127.0.0.1；由 nginx 分流对外） |
| 部署 | `font-cloud-server/deploy/deploy.ps1`（tar.gz → scp → install-on-server.sh） |
| 入口 | `/font-cloud`（工具指针）· `/font-bench/`（测试台）· `/api/subset` 等 |
| Agent | `/llms-font-cloud.txt` · `/font-cloud.json` · `/docs/protocol.md` · `/docs/architecture.md` |
| nginx | `firmware-server.conf` 内插入分流块（备份 `.conf.bak-before-font-cloud`） |
| 不冲突 | firmware 保留 `/llms.txt`、`/docs/*.md`（其一）、`/api/registry|status|token|publish` |

运维：`systemctl status font-cloud-server` · `journalctl -u font-cloud-server -f` ·
`systemctl show font-cloud-server -p ExecMainStartTimestamp --value`（部署后必查）

## 6. 已知限制与尾巴

| 项 | 状态 |
|---|---|
| 自签证书 | 浏览器点信任即可；严格 TLS 客户端走 **http:80 只读通道**。正式 LE 证书可选（需 DNS 子域如 `fw.panel.example.com`，不建议动现有域名站点证书） |
| http:80 明文 | 只读文档/数据用；写请求（token）建议走 https |
| `--watch` 后台发布 | 本机 `Start-Process` 后台 fetch 失败（问题 20，前台 once 一直正常）——**发布暂用手动 once** |
| 门2 挂起 | D4 启动日志核对 + console 切换（用户暂缓） |
| rebuild 丢元数据 | project 级 subscribed/retention 需从备份恢复（§5） |
| retention 执行时机 | 策略设置后**下次 publish** 才清理（设计如此，非立即删） |

## 7. 关联文档

- 通用部署手册：`/docs/DEPLOY.md`（Caddy/nginx 方案、systemd 模板、systemd/备份）
- 发布操作：`/docs/PUBLISH.md`（CLI/裸 HTTP/config/token）
- AI 速查：`/llms.txt`
- 设计：`/docs/FIRMWARE-REGISTRY.md` · 验收：`/docs/REQUIREMENTS.md`
- 本地进度与问题清单：仓库 `PROGRESS.md`（不挂公网）
