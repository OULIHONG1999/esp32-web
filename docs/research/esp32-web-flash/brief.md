# Research Brief — ESP32 网页端固件下载（Web Flash）方案调研

## Refined question
在浏览器中实现乐鑫 ESP32 固件烧录/下载的可行技术方案有哪些？各方案的原理、成熟度、浏览器兼容性、硬件前提、集成成本与局限是什么？为后续（暂不实施的）技术选型提供依据。

## Scope boundaries
### In scope
- 浏览器直连串口烧录：Web Serial API + esptool-js / ESP Web Tools 等官方与第三方库
- 其他浏览器通道：WebUSB、Web Bluetooth 等是否可用于烧录
- 乐鑫官方 Web 方案：esptool-js、esp-web-tools、ESP Launchpad、ESP Web Tools manifest 机制
- 第三方/社区 Web 烧录方案与在线烧录器
- 浏览器兼容性、HTTPS/安全上下文要求、权限与自动下载（auto-reset）电路等硬件前提
- 与 OTA（HTTP/云端升级）等替代"网页端更新"路径的对比
- 集成方式（npm 包、CDN、manifest 文件）、芯片支持范围（ESP32/S2/S3/C3/C6/H2 等）、已知坑与限制

### Out of scope
- 实际编码实现（用户明确"不要实现"）
- esptool.py 本地 CLI 用法细节
- 非乐鑫芯片（RP2040、STM32 等）的网页烧录细节（仅在对比时提及）

## Assumptions
- 受众：准备在自有 Web 项目（esp32-web）中做技术选型的工程师
- 关注当前（2026）最新版本与浏览器支持现状
- 报告语言：中文（技术术语保留英文原文）

## Depth mode
standard（3-5 个 sub-agent，1 轮 follow-up，15+ 来源）

## Date
2026-09-26

## Angles
1. F1 — 乐鑫官方 Web 烧录方案：esptool-js、esp-web-tools、ESP Launchpad 的能力、版本、架构与芯片支持
2. F2 — Web Serial API 浏览器机制与兼容性：安全上下文、权限、自动复位（DTR/RTS）硬件前提、已知限制
3. F3 — 第三方/社区 Web 烧录方案与替代通道（WebUSB、OTA/HTTP 升级、在线烧录器）
4. F4 — 集成实战经验与坑：npm/manifest 集成方式、大固件烧录稳定性、串口占用、常见失败案例（论坛/GitHub issues）
