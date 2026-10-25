#!/bin/sh
# 一个进程组里拉起"能被人看见的浏览器"：
#   Xvfb(虚拟屏) -> x11vnc(只监听 127.0.0.1) -> noVNC/Basic 认证 -> Chrome
# Chrome 的 CDP(9223) 和 VNC(5900) 都只在本地，外部只能通过 noVNC(6080) 进来。
set -eu

DISPLAY_NUM="${DISPLAY_NUM:-:99}"
SCREEN="${SCREEN:-1280x900x24}"
CDP_PORT="${CDP_PORT:-9223}"
PROFILE="${PROFILE:-/var/lib/mimo/profile}"
BROWSER="${BROWSER:-/usr/bin/google-chrome}"

export DISPLAY="$DISPLAY_NUM"

Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -nolisten tcp &
sleep 1

x11vnc -display "$DISPLAY_NUM" -rfbport 5900 -localhost -forever -shared \
       -nopw -quiet &
sleep 1

# Basic 认证文件由 setup_debian.sh 生成（格式 user:pass）
if [ -f /etc/mimo/vnc.pass ]; then
    websockify --web=/usr/share/novnc \
        --auth-plugin=BasicHTTPAuth --auth-source=/etc/mimo/vnc.pass \
        6080 127.0.0.1:5900 &
else
    echo "[console] /etc/mimo/vnc.pass 不存在，noVNC 只监听 127.0.0.1" >&2
    websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &
fi

mkdir -p "$PROFILE"
# --no-sandbox：云主机常以受限用户/容器方式运行；这是一个一次性 profile。
exec "$BROWSER" \
    --no-sandbox --disable-dev-shm-usage \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$CDP_PORT" \
    --no-first-run --no-default-browser-check \
    --window-size=1280,900 \
    https://platform.xiaomimimo.com/console/plan-manage
