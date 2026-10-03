#!/usr/bin/env bash
# font-cloud 远端安装：在服务器上以 root 执行（由 deploy.ps1 通过 ssh 调用）
set -e
PY=/usr/bin/python3.10
APP=/opt/font-cloud-server
PORT=${PORT:-8788}

rm -rf "$APP.unz"
mkdir -p "$APP.unz" "$APP/cache" "$APP/data"
if [ -f /tmp/font-cloud-deploy.tar.gz ]; then
  tar -xzf /tmp/font-cloud-deploy.tar.gz -C "$APP.unz"
else
  unzip -qo /tmp/font-cloud-deploy.zip -d "$APP.unz"
fi
cp -a "$APP.unz/server.py" "$APP.unz/requirements.txt" "$APP.unz/README.md" "$APP/"
cp -a "$APP.unz/public" "$APP/"
cp -a "$APP.unz/fonts" "$APP/"
cp -a "$APP.unz/deploy" "$APP/"
rm -rf "$APP.unz"

cd "$APP"
if [ ! -x "$APP/.venv/bin/python" ]; then
  "$PY" -m venv "$APP/.venv"
fi
"$APP/.venv/bin/pip" install -q -r requirements.txt
"$APP/.venv/bin/python" -c "import fontTools; print('fontTools', fontTools.__version__)"

cp deploy/font-cloud-server.service /etc/systemd/system/font-cloud-server.service
systemctl daemon-reload
systemctl enable font-cloud-server >/dev/null 2>&1 || true
systemctl restart font-cloud-server
sleep 1
echo "service: $(systemctl is-active font-cloud-server)"
echo "start:   $(systemctl show font-cloud-server -p ExecMainStartTimestamp --value)"

CONF=/www/server/panel/vhost/nginx/firmware-server.conf
if ! grep -q 'font-bench' "$CONF"; then
  cp "$CONF" "$CONF.bak-before-font-cloud"
  python3.10 - <<'PYNG'
from pathlib import Path
conf = Path("/www/server/panel/vhost/nginx/firmware-server.conf")
block = Path("/opt/font-cloud-server/deploy/nginx-font-cloud.conf").read_text(encoding="utf-8")
text = conf.read_text(encoding="utf-8")
anchor = "    location / {"
if anchor not in text:
    raise SystemExit("anchor not found: location / {")
text = text.replace(anchor, block + "\n" + anchor, 1)
conf.write_text(text, encoding="utf-8")
print("nginx conf updated")
PYNG
  /www/server/nginx/sbin/nginx -t
  /www/server/nginx/sbin/nginx -s reload
  echo "nginx reloaded"
else
  echo "nginx already has font-bench routes"
fi

echo "---- local checks ----"
curl -sS http://127.0.0.1:8788/health; echo
curl -sS -o /dev/null -w 'meta %{http_code}\n' http://127.0.0.1:8788/api/meta
curl -sS -o /dev/null -w 'tool-json %{http_code}\n' http://127.0.0.1:8788/font-cloud.json
curl -sS -o /dev/null -w 'bench %{http_code}\n' http://127.0.0.1:8788/
