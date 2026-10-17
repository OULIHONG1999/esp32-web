# STRUCTURE — 代码结构（当前）

> PROGRESS 拆出的「分」文档之一。**随代码新增/删除同步更新本清单**（目录树 + 简短职责注释）。
> 现行状态/下一步见根目录 `PROGRESS.md`；关键决策与坑见 `docs/progress/decisions.md`。

```
src/core/                    纯逻辑（零依赖，改这里必配测试）——10 文件：
  device.ts                   DeviceManager 设备常驻状态机（TRANSITIONS/ALLOWED；D1 降速重试/D2 超时/D3 clearError）
  log.ts                      Logger 环形缓冲 + seq 序号 + esptool 行分级
  errors.ts                   七类错误翻译（TimeoutError name 前置分类）
  lines.ts                    串口行切分器（纯逻辑）
  zip.ts                      STORE zip 生成器（N7 导出固件包，零依赖可单测）
  firmwarePack.ts             flash_args/README 文本生成（N7）
  md5.ts                      同步 MD5（D5，node:crypto 对拍 + RFC 向量）
  progress.ts                 烧录进度段内比例换算（overallWritten，跨压缩口径）
  binInfo.ts                  bin 镜像头/分区表/字符串/SHA-256 解析（A2）
  tokenLink.ts                设置链接片段解析/构造（#token=，免记口令）
src/glue/                     esptool-js 粘合层（唯一允许 import esptool-js）——6 文件：
  esptool.ts                  esptool-js 唯一接触面
  monitor.ts                  SerialMonitor 实时读取流
  deviceOps.ts                DeviceDeps 实现：lastPort 复用 + 流/esptool 互斥 + reopenForRetry + preparePort
  signalReset.ts              esp_idf_monitor 同源信号复位时序（R-1）
  deviceLocks.ts              Web Locks 跨标签互斥
  audioFeedback.ts            Web Audio 提示音合成（零音频文件）
src/composables/              Vue 接线——3 文件：
  useSession.ts               批量 flush、暂停视图、状态镜像、autoMonitor（烧录后自动监视）
  useFirmwareWorkspace.ts     固件工作区单例（rows+registry 侧栏树/固件页/时间线共享）
  useServiceStatus.ts         /api/status 单例快照（side-card + 状态栏共用）
src/api/registry.ts           v1.5 项目库客户端（registry/parts 下载、flattenLatest、flashParams 映射）
src/components/               Vue UI：
  LogPanel.vue                日志面板（智能自动滚动 + ↓回到底部悬浮钮）
  FirmwarePanel.vue           固件页（参数条/烧录清单/载入）
  VersionTimeline.vue         版本时间线（晋升/回滚/保留数）
  FlashHistory.vue            烧录历史（localStorage 20 条）
  EnvCheck.vue                环境自检引导页
  ide/                        五区骨架：Sidebar/TreeSection/TreeItem/EditorTabs/BottomPanel/StatusBar

public/                      静态资源（build 拷入 dist）：
  ota/                        OTA 独立页（原生 JS 零依赖，不进主 SPA）
  coredump/                   崩溃上报独立页（珊瑚红 accent）
  drive/                      云盘独立页（天蓝 accent）
  ota.json / coredump.json / drive.json / push.json   4 个机器描述符（AI 入口）
  llms.txt / ota.json         AI 可读面
  tools/device-sim/           设备模拟器镜像（供设备机下载）
  tools/publish/              发布/push CLI 镜像（6 文件，字节级一致）
  docs/                       公网文档镜像（改 docs/ 源头后同步拷贝）

server/                      v1.5 自含服务（纯 JS 零依赖 node:http）——13 文件：
  index.js / app.js / config.js      启动/路由装配/env 配置
  registry.js                        registry 原子读写 + ETag + parts 下载
  publish.js                         发布（鉴权/白名单/SHA256/原子落位/幂等补传）
  releases.js                        promote/setLatest/retention
  stream.js                          SSE hub（订阅/心跳/广播）
  tokens.js                          双层 token（主 token + wk_ 工作 token）
  devices.js                         OTA/fetch 设备与命令存储（纯函数 + 原子写 devices.json）
  coredumps.js                       coredump 存储（幂等 + retention + 原子写）
  drive.js                           云盘存储（上传/列表/下载/删除 + 净化 + 配额）
  multipart.js                       multipart 解析
  rebuild.js                         部署自愈（重建 registry 索引）

tools/publish/               发布/推送 CLI（零依赖）——6 文件：
  index.js / lib.js / once.js       发布 CLI（once/--watch/promote/push）
  watch.js                           --watch 轮询防抖
  push.js / pushlib.js               push 子命令（发布+下发+等结果；退出码 0–12）

tests/                       Vitest（node 环境）——23 文件 · 392 用例全绿：
  *.test.ts（12，前端核心层）: device/log/errors/lines/md5/zip/firmware-pack/progress/bininfo/tokenLink/environment/registry-stream
  *.test.js（11，server/CLI）: server/devices/device-sim/publish-cli/publish-watch/e2e/static-pages/coredumps/drive/fetch/push-cli
  fixtures/                   假构建产物（e2e 用）
```

> 已删除（方向1 取代/功能移除）：`core/session.ts`、`glue/sessionDeps.ts`、`tests/session.test.ts`、`api/buildArtifacts.ts`、`api/buildCommands.ts`、`composables/useIdfBuild.ts`、`tests/api.test.ts`。