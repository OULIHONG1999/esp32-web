#!/usr/bin/env python3
"""一次性准备（Debian/Ubuntu，不用 Docker）。重复执行安全。

    sudo APP=/opt/mimo python3 setup_debian.py

为什么是 .py 而不是 .sh
------------------------
仓库在 Windows 上开发，`core.autocrlf=true` 会把 `.sh`/`.service` 检出成
CRLF，传到 Linux 上第一行就报 `$'\\r': command not found`。Python 解析器
容忍 CRLF，所以入口用 .py，由它把 shell/systemd 模板统一洗成 LF 再落地。

做的事：装依赖 -> 建 mimo 用户 -> 生成 noVNC 密码和 config.json（随机 token）
      -> 洗换行并安装 start_console.sh 与三个 systemd 单元 -> 启动。
"""
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # tools/balance_gateway/cloud
GW = HERE.parent                                # tools/balance_gateway
APP = Path(os.environ.get("APP", "/opt/mimo"))  # 项目根目录
SERVICES = ("mimo-console.service", "mimo-gateway.service", "mimo-keeper.service")


def run(cmd, **kw):
    print("   $", " ".join(cmd) if isinstance(cmd, list) else cmd)
    subprocess.run(cmd, check=True, **kw)


def write_lf(src: Path, dst: Path, mode: int, app: Path):
    """模板 -> 目标文件，强制 LF（Windows 检出会是 CRLF，systemd 会认坏）。"""
    text = src.read_text(encoding="utf-8")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if str(app) != "/opt/mimo":
        text = text.replace("/opt/mimo", str(app))
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    dst.chmod(mode)


def main():
    if not sys.platform.startswith("linux"):
        print("这个脚本是给 Linux 用的；Windows 请直接用 browser_session.py", file=sys.stderr)
        return 1
    if os.geteuid() != 0:
        print("需要 root：sudo APP=%s python3 setup_debian.py" % APP, file=sys.stderr)
        return 1
    if not (GW / "balance_gateway.py").is_file():
        print("找不到 %s/balance_gateway.py；用 APP=项目根目录 重新跑" % GW,
              file=sys.stderr)
        return 1

    print("== 1/5 系统依赖")
    run(["apt-get", "update"])
    run(["apt-get", "install", "-y", "--no-install-recommends",
         "python3", "xvfb", "x11vnc", "novnc", "websockify",
         "ca-certificates", "wget", "fonts-noto-cjk"])
    try:
        import websocket  # noqa: F401
    except ImportError:
        run(["apt-get", "install", "-y", "python3-websocket"])

    print("== 2/5 浏览器")
    # Ubuntu 的 chromium 是 snap 包，systemd 里容易起不来，优先用 Chrome deb
    if not any(Path(p).exists() for p in ("/usr/bin/google-chrome",
                                          "/usr/bin/chromium",
                                          "/usr/bin/chromium-browser")):
        deb = Path("/tmp/chrome.deb")
        run(["wget", "-q", "-O", str(deb),
             "https://dl.google.com/linux/direct/"
             "google-chrome-stable_current_amd64.deb"])
        run(["apt-get", "install", "-y", str(deb)])
        deb.unlink(missing_ok=True)

    print("== 3/5 运行用户")
    if subprocess.run(["id", "mimo"], capture_output=True).returncode != 0:
        run(["useradd", "-r", "-m", "-d", "/var/lib/mimo",
             "-s", "/usr/sbin/nologin", "mimo"])

    print("== 4/5 凭证")
    vnc_pass = Path("/etc/mimo/vnc.pass")
    if not vnc_pass.exists():
        vnc_pass.parent.mkdir(parents=True, exist_ok=True)
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
        pwd = "".join(secrets.choice(alphabet) for _ in range(12))
        with open(vnc_pass, "w", encoding="utf-8", newline="\n") as f:
            f.write("mimo:%s\n" % pwd)
        vnc_pass.chmod(0o600)
        print("   noVNC 登录：用户名 mimo  密码 %s   （记下来）" % pwd)

    cfg_path = GW / "config.json"
    if not cfg_path.exists():
        token = secrets.token_urlsafe(24)
        cfg = {"mode": "xiaomi", "xiaomi_kind": "credits",
               "listen_host": "0.0.0.0", "listen_port": 8088,
               "auth_token": token, "cache_ttl": 60, "upstream_retries": 2}
        with open(cfg_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        print("   设备端请求头 X-Auth-Token: %s" % token)
    cfg_path.chmod(0o600)
    run(["chown", "-R", "mimo:mimo", str(GW)])

    print("== 5/5 systemd")
    script = GW / "cloud" / "start_console.sh"
    write_lf(script, script, 0o755, APP)              # 原地洗掉 CRLF 并加可执行位
    for name in SERVICES:
        write_lf(HERE / name, Path("/etc/systemd/system") / name, 0o644, APP)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", "mimo-console",
         "mimo-gateway", "mimo-keeper"])

    ip = "服务器IP"
    print("""
完成。下一步：
  1) 打开 http://%s:6080/vnc.html（用户名 mimo），登录小米控制台
  2) cd %s && python3 session_keeper.py --once      # 应打印 session: OK
  3) 设备访问 http://%s:8088/summary，带 X-Auth-Token
  4) 云安全组只放行 8088 和 6080；5900/9223 不要开
  5) 看日志：journalctl -u mimo-gateway -f
""" % (ip, GW, ip))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
