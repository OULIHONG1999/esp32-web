# FETCH 通道 —— 设备端实现（01）

> **【智能体速读】**
>
> * **这篇讲什么**：设备端如何接收并执行 `fetch` 命令：新增 `components/fetcher/` 组件 + `ota.cpp` 一处分发，复用现有轮询循环与回执端点。
> * **什么时候读**：动手实现设备端 fetch 时——**全文必读**。接口契约（命令 JSON / 信封 / 回执 / 状态机）以 [`README.md`](README.md) §3 为准，本文不重复定义，只写设备侧行为。
> * **阅读模式**：`全文必读`（约 200 行）。
> * **关键小节**：§3 执行流程；§4 校验与错误码表（`detail` 文案以本表为准）；§5 线程与并发约束。
> * **最容易踩的点**：① **绝不在 LVGL 线程做下载/写盘**（与 TF 卡卸载、EAF 播放抢线程会出诡异问题）；② **OTA 进行中收到 fetch 必须回 `failed: busy`**，不能排队；③ 覆盖写必须 **`tmp → unlink → rename`**，直接写 `dest` 半路断电会留半个文件；④ 解析信封时 `maxBytes` 是**可缺省字段**，缺省 256 KB。

***

## 1. 现状与根因

* OTA（`components/ota`）已经打通：15 s report 轮询 → report 响应携带 `type:"ota"` 命令 → 下载校验写入 OTA 槽 → 重启 → `POST .../result` 回执（NVS 暂存断电前的未发回执）。
* OTA 用 `esp_ota_ops` **只写 app 槽**——storage 分区（`/fs`）永远不经过 OTA。这是 fetch 通道存在的根因（详见 [`README.md`](README.md) §1）。
* `pages/vanim` 的 FETCH 按钮是雏形：固定 URL → `net::http_get`（PSRAM）→ `mkdir("/fs/vanim")`（EEXIST 放行）→ 写 `/fs/vanim/fetched.json`。本方案把这套路子抽成通用组件。

## 2. 组件设计

### 2.1 新组件 `components/fetcher/`

```
components/fetcher/
  fetcher.hpp
  fetcher.cpp
  CMakeLists.txt        # REQUIRES net sdcard；不依赖 LVGL
```

接口（草案，实现时可微调，语义不变）：

```cpp
namespace fetcher {

struct Request {
    const char *url;        /**< full http:// URL */
    const char *dest;       /**< /fs/... or /sdcard/... */
    size_t maxBytes;        /**< download cap; 0 = default 256 KB */
};

/** One fetch, blocking, on the caller's task. Returns true on success.
 *  detail: ASCII reason (<=120 B) for the command result, both paths. */
bool run(const Request &req, char *detail, size_t detailLen);

/** True while a fetch is in flight (single-flight guard). */
bool busy();

} // namespace fetcher
```

### 2.2 `components/ota/ota.cpp` 的改动（分发点）

1. `parse_command()` 增加第二个分支：`type == "fetch"` 时提取 `url` / `dest` / `maxBytes`（`maxBytes` 可缺省）。命令结构体加一组字段（或并排一个 `FetchCommand` 子结构）。
2. agent 主循环收到 fetch 命令后：
   * `ota::busy()`（OTA 正在写槽）→ `post_result(cmd.id, "failed", "busy")`；
   * 否则**在本 agent 任务里**调 `fetcher::run()`（阻塞，但这是后台任务，不碰 LVGL）；
   * 用返回值 + `detail` 调 `post_result(cmd.id, "success"|"failed", detail)`。
3. `post_result()` 与 NVS 暂存重发机制（`send_pending_result()`）**原样复用**：fetch 的回执同样享受"断电不丢"。

> 不给 fetch 单开轮询任务——report 循环只有一个，谁拥有它谁分发。

## 3. 执行流程（fetcher::run 内部，按序）

1. **参数校验**（§4 表）——任何一条不过，直接 `return false` + 对应 detail，**不碰网络**。
2. **单飞检查**：`busy()` 已为 true → `failed: busy`（理论上分发层已挡，这里兜底）。
3. **落点预检**：
   * `dest` 前缀 `/fs/`：`statvfs("/fs")` 取剩余空间；若响应带 `Content-Length` 且大于剩余空间 → `failed: no space`；
   * `dest` 前缀 `/sdcard/`：`sdcard::is_mounted()` 为假 → `failed: no TF card`。
4. **逐级建目录**：从根到 `dest` 的父目录逐级 `mkdir()`，`errno == EEXIST` 放行——"没有文件夹就创建"落在这里。注意 VFS `mkdir` **不递归**，必须自己逐级。
5. **清理孤儿**：若 `dest.tmp` 已存在（上次断电残留）→ `unlink()`。
6. **下载**：`net::http_get(url, &data, &len, maxBytes)` → PSRAM。非 200 / 超限 / 网络错误 → `failed: http ...`。
7. **写入与覆盖**：`fopen(dest.tmp, "wb")` → `fwrite` → `fclose`（LittleFS 断电安全由文件系统保证，无需 fsync）；然后 `unlink(dest)` → `rename(dest.tmp, dest)`。成功 → `success: wrote {len} bytes to {dest}`。
8. 释放 PSRAM 缓冲，返回。

> 同名文件直接覆盖：第 7 步的 `unlink + rename` 就是覆盖语义。LittleFS 的 `rename` 对已存在目标的行为不作依赖——先 unlink 再 rename，行为确定。

## 4. 校验与错误码表（`detail` 以本表为准，全部 ASCII）

| # | 检查 | 失败 `detail` |
|---|---|---|
| 1 | `dest` 以 `/fs/` 或 `/sdcard/` 开头 | `bad dest: must start with /fs/ or /sdcard/` |
| 2 | `dest` 只含 ASCII 可打印字符，无 `..`，总长 ≤ 127 | `bad dest: illegal path` |
| 3 | `url` 以 `http://` 开头，长度 ≤ 256 | `bad url` |
| 4 | `maxBytes` ∈ 1..4194304（缺省 262144；越界取边界而非报错） | —（钳位，不失败） |
| 5 | TF 卡目标但未挂载 | `no TF card` |
| 6 | `/fs` 剩余空间不足（仅当 Content-Length 已知时预检） | `no space` |
| 7 | 下载失败 / 非 200 / 超限 | `http <esp_err 或状态码>` |
| 8 | 目录创建 / 写文件 / rename 失败 | `io: <errno 名或描述>` |
| 9 | OTA 进行中 | `busy` |

## 5. 线程与并发约束

* fetch 的**下载与写盘只发生在 OTA agent 的后台任务**（或 fetcher 自己的工作任务），**绝不进 LVGL 线程**——LVGL 线程同时可能持有 LVGL 锁、读写 `/fs`（字体缓存）或 `/sdcard`（EAF 播放）。
* ⚠️ **TF 卡卸载由 `ui::installSdWatcher()` 在 LVGL 线程触发**（项目已知约束）。fetch 写 TF 期间若用户拔卡，写失败 → `io:` 错误回执即可，**不要**在 fetcher 里碰 sdcard 的挂载/卸载 API。
* 单飞：同一时刻至多一条 fetch；命令串行由"每设备一条未决命令"保证。
* fetch 与 OTA 互斥：OTA 优先，fetch 让路并回 `busy`。

## 6. 幂等与重投

* 服务器会把未收到回执的命令重投；fetch **每次都重新执行**（不做"同命令去重"）——重复执行就是重复覆盖同一份内容，结果一致。
* 不需要 NVS 记录"已执行过哪个 fetch"；只复用"未发回执"的 NVS 暂存。

## 7. 安全边界

* `dest` 白名单**只有 `/fs/` 与 `/sdcard/` 两棵子树**；`/nvs`、`/coredump`、OTA 槽等任何其他位置不可达（VFS 层面前缀校验即挡住）。
* 大小上限 `maxBytes` 保护 PSRAM（8 MB）与 flash（`/fs` 共 ≈9.9 MB，且已有字体/音频/表情占用）。
* 仅明文 HTTP（与 OTA/fontnet 现状一致）；引入 HTTPS 需先改 `components/net`，不在本期。

## 8. 测试清单（设备侧自测，可不依赖服务器）

用任一能开 HTTP 的机器做源（`python -m http.server`）：

1. 正常：下载一个小 JSON → `/fs/vanim/test.json` → 回执 success；FILE MANAGER 页可见。
2. 建目录：`dest` 指向不存在的两级目录 → 目录被逐级创建。
3. 覆盖：同 `dest` 下发两次（内容不同）→ 第二次内容生效，无 `.tmp` 残留。
4. 坏 `dest`：`/nvs/x`、`../x`、含中文 → 分别回对应 `bad dest`。
5. TF：拔卡下发 `/sdcard/...` → `no TF card`；插卡后成功。
6. 超限：`maxBytes=1024` 下载 10 KB 文件 → `http` 错误（超限）。
7. 空间：向 `/fs` 请求超过剩余空间的大文件（Content-Length 已知）→ `no space`。
8. 断电：写 `dest.tmp` 中途复位 → 重启后重新下发同命令 → 孤儿 `.tmp` 被清理，最终文件正确。
9. 并发：OTA 进行中下发 fetch → `busy`。
10. 页面回归：fetch 落盘 `/fs/vanim/robot.json` 后，vanim 播放页 LIST 能列出并播放。

## 9. 明确不做（本期）

* 不做 HTTPS、断点续传、校验和验证（HTTP 层已有 TCP 校验；需要强校验时后续给命令加 `sha256` 字段，契约已留扩展位）。
* 不做目录级下发（一条命令一个文件）。
* 不做设备端 UI（进度与结果只进服务器/日志；FILE MANAGER 页天然可见结果）。
* 不删除设备上的文件（fetch 只写不删；删除后续按需加 `type:"rm"`，不在本契约内）。
