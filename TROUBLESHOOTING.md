# TROUBLESHOOTING — 故障排查指南

> 面向：网站使用者与 AI 智能体 · 2026-09-29
> 现象→判定→修复，按频率排序。服务器侧问题另见 `/docs/SERVER.md`。

## 1. 实时日志没有设备输出（最常见，配置问题非故障）

### 症状判定

| 现象 | 结论 |
|---|---|
| 烧录时有 `Connecting... / Writing at 0x0...` 日志，**复位后却永远没有**设备自己的输出（如 Hello world 循环） | ✅ 就是本条：**固件 console 口配置问题**，不是页面/服务器故障 |
| 连接直接失败、连 esptool 日志都没有 | 见 §2 串口被占用 |
| 日志面板完全空白（连烧录过程都没有） | 见 §2 / 刷新页面重连 |

### 原理（为什么复位/硬复位都没用）

```
芯片程序 printf 的输出走哪个口 = 固件编译时的配置决定
    ├─ Channel for console = UART0（默认）→ 输出走 UART0 引脚
    │                        你插的 USB-Serial/JTAG 口上【物理上没有这些数据】
    └─ Channel for console = USB Serial/JTAG → 输出走 USB 口 → 页面实时日志可见 ✅

页面实时日志读取的 = USB-Serial/JTAG 口（Web Serial）
烧录过程日志（esptool 输出）= 上位机自己打的，与口无关 → 所以烧录日志一直正常
```

**硬复位为什么救不了**：复位只是让程序重新运行一遍——重启后它仍然往 UART0 打印（编译时定死）。如同电视信号在 A 频道，反复重启电视不会让它跳到 B 频道——必须重新编译换"频道"。

### 修复（改一次编译永久生效）

在构建机（Windows + ESP-IDF）执行：

```powershell
cd <你的工程>                    # 如 D:\ESP\v6.1\esp-idf\examples\get-started\hello_world
. "C:\Espressif\tools\Microsoft.v6.1.PowerShell_profile.ps1"   # 激活 IDF 环境
idf.py menuconfig                 # 菜单操作（交互式，不要手改 sdkconfig 文本）
# 导航：Component config → ESP System Settings → Channel for console
#   改为：USB Serial/JTAG        （搜索技巧：菜单内按 / 搜 console）
# Save → Exit
idf.py build                      # 重新编译
```

编译完成后**重新发布**（`publish once` 或页面所在的发布链）→ 页面载入新版本 → 烧录：

- 自动复位后，实时日志应滚出设备输出（Hello world 循环）
- 启动 banner 可同时核对烧录参数（`boot: SPI Speed / Flash Size` 是否与发布参数一致）

> 注意：不要用文本编辑器直接改 sdkconfig 实现本项（Kconfig 依赖易冲突，实测踩坑）——永远走 menuconfig。
> 也不要在没有编译的情况下重复烧录旧固件——配置在编译期固化，旧固件怎么烧都还是 UART0。

## 2. 连接失败 / 串口被占用

- **症状**：点「连接」报错、PortBusy、或日志流开不起来
- **原因**：浏览器多个标签页同时打开本站时，Web Serial 端口被其中一个占用（本工具为单端口独占模型）
- **修复**：关闭**所有**本站标签页 → 只保留一个 → 重新连接（端口授权长期保留，通常无需重选）
- 服务器侧排查见 `/docs/SERVER.md` §6

## 3. 401 unauthorized（晋升/回滚/保留策略失败）

- 写接口需要 Bearer token → 点右上角 **🔑** 设置（首次会提示输入）
- token 值由运维者提供（服务端 `FIRMWARE_PUBLISH_TOKEN`）；设置一次存本机浏览器
- CLI/脚本侧写法见 `/docs/PUBLISH.md` §1

## 4. 发布相关速记

| 现象 | 说明 |
|---|---|
| 上传=0（服务器已有，秒回） | 正常：内容未变，按 SHA256 跨版本复用（增量） |
| 烧录日志出现 `已达波特率下限…重试` | 正常：首次写入失败后自动降速重建重试一次（F-05）；重试原因会打进日志 |
| 每段末尾 `Hash of data verified.` | 正常：MD5 写入校验通过（D5） |
| 页面 `烧录参数 freq=40m size=4MB` | 若与预期不符，说明载入的是未含参数的旧路径——用「项目库/时间线载入」（注入 flash_args 权威参数） |
| 证书警告（https://IP） | 自签证书：浏览器点「高级→继续」；AI/脚本可用 http:// 通道读文档与数据 |

## 5. SSE 横幅不出现（发布后页面没提醒）

1. 确认右上角状态为 `● 订阅中`（`○ 轮询` = 降级模式，仍会 30s 内感知）
2. 硬刷新页面（Ctrl+F5）后重试
3. 发布是否真的成功：`GET /api/registry` 看 latest 是否变化

## 6. 相关文档

- AI/API 速查：`/llms.txt`
- 发布操作：`/docs/PUBLISH.md`
- 部署状态：`/docs/SERVER.md` · 通用运维：`/docs/DEPLOY.md`
- 设计：`/docs/FIRMWARE-REGISTRY.md` · 验收清单：`/docs/REQUIREMENTS.md`
