#!/usr/bin/env bash
# 在你自己电脑上跑（Git Bash，仓库目录里）：把当前 HEAD 打包 → 传到服务器 → 解包 → 重启 → 验证。
# 服务器上不装 git、不需要能访问 GitHub；数据文件（db.json / config.json）不在包里，不会被覆盖。
#
#   bash tools/deploy-update.sh                    # 默认 root@159.198.67.190
#   bash tools/deploy-update.sh root@1.2.3.4 3580  # 换主机或端口
#
# 首次部署不要用这个：那时还没有服务可重启，去看 DEPLOY.md 第 0 节和第 6 节。
set -euo pipefail

HOST="${1:-root@159.198.67.190}"
PORT="${2:-3580}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_TGZ="/root/pokemmo-report.tar.gz"

cd "$ROOT"
test -f server.js || { echo "× 这里不是仓库根：$ROOT"; exit 1; }
git rev-parse --verify HEAD >/dev/null
SHA="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "! 工作区有未提交的改动，但只会打包已提交的 HEAD（$SHA）——这些改动不会上服务器"
fi

echo "1/5 先确认能连上服务器的 22 端口"
if timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null; then
  echo "  ssh 可达，且已配好公钥（不会提示输密码）"
else
  ERR="$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>&1 || true)"
  if printf '%s' "$ERR" | grep -qiE 'permission denied|publickey|passphrase|password'; then
    echo "  ssh 可达但没配公钥：接下来会提示输密码（一共 2 次）"
  else
    echo "× 连不上 $HOST 的 22 端口 —— ${ERR:-没有输出（多半是超时）}"
    echo "  这台电脑没法远程更新。两条路："
    echo "  ① 云控制台 → 防火墙/安全组 放行 TCP 22（更稳的做法是只放行你自己的出口 IP），再重跑本脚本；"
    echo "  ② 保持 22 关闭，在服务器终端（云控制台网页终端也行）里跑 tools/server-update.sh，让服务器自己去 GitHub 取代码。"
    exit 1
  fi
fi

echo "2/5 打包 HEAD $SHA 并通过 ssh 传到 $HOST:$REMOTE_TGZ"
git archive --format=tar.gz HEAD | ssh "$HOST" "cat > $REMOTE_TGZ && ls -la $REMOTE_TGZ"

echo "3/5 远端识别部署方式并更新代码"
ssh "$HOST" "POKE_PORT='$PORT' REMOTE_TGZ='$REMOTE_TGZ' bash -s" <<'REMOTE'
set -e
test -f "$REMOTE_TGZ" || { echo "× 服务器上没收到包"; exit 1; }

MODE=""
if systemctl list-unit-files 2>/dev/null | grep -q '^poke[.]service'; then MODE=systemd; fi
if [ -z "$MODE" ] && command -v docker >/dev/null 2>&1 \
   && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx pokemmo-report; then MODE=docker; fi
if [ -z "$MODE" ] && [ -f /opt/pokemmo-report/server.js ]; then MODE=dir-only; fi

if [ -z "$MODE" ]; then
  echo "× 服务器上找不到已部署的痕迹：没有 poke.service、没有 pokemmo-report 容器、/opt/pokemmo-report 里没代码"
  echo "  这属于首次部署，别用更新脚本，按 DEPLOY.md 第 0 节传包 + 第 6 节建 systemd 单元"
  exit 2
fi
echo "  部署方式：$MODE"

mkdir -p /opt/pokemmo-report
tar xzf "$REMOTE_TGZ" -C /opt/pokemmo-report
test -f /opt/pokemmo-report/server.js || { echo "× 解包后没看到 server.js"; exit 1; }
sed -n 's/BUILD_VERSION="\(.*\)"/  包里代码版本：\1/p' /opt/pokemmo-report/BUILDINFO 2>/dev/null || true
ls /opt/pokemmo-report/public/assets/sprites | wc -l | sed 's/^/  图鉴图数量：/'
[ -f /opt/pokemmo-report/data/config.json ] && echo "  配置与数据库在 data/ 下，本次未改动" || echo "  ! data/config.json 还没有，管理台设置是默认值"

case "$MODE" in
  systemd)
    echo "3/4 重启 poke 服务"
    systemctl restart poke
    sleep 8
    journalctl -u poke -n 8 --no-pager
    ;;
  dir-only)
    echo "3/4 代码已更新，但没有 poke.service —— 先按 DEPLOY.md 第 6 节建单元，再 systemctl start poke"
    ;;
  docker)
    echo "3/4 你是 Docker 部署：代码已经解到 /opt/pokemmo-report，但**镜像不重建就不生效**"
    echo "    （docker restart 只重启旧镜像，管理台会看起来毫无变化）。这一步不替你删容器，"
    echo "    在服务器上跑下面这条——脚本刚才已经跟着包解到那个目录里了，它会重建镜像、"
    echo "    旧容器只改名、新容器验到 HTTP 200 才删，起不来当场恢复："
    echo "    bash /opt/pokemmo-report/tools/server-docker-upgrade.sh --mount=/opt/pokemmo/data:/app/data"
    echo "    数据目录不是 /opt/pokemmo/data 就换成 docker inspect 里那个 Source；密码被环境变量盖住时加 --reset-admin"
    ;;
esac

echo "4/5 服务器上自检"
curl -s -m 10 -o /dev/null -w "  本机 127.0.0.1:$POKE_PORT → HTTP %{http_code}\n" "http://127.0.0.1:$POKE_PORT/api/board" \
  || echo "  × 端口 $POKE_PORT 没在监听：看上面的 journalctl（没起来就别去查防火墙）"
curl -s -m 10 "http://127.0.0.1:$POKE_PORT/api/board" 2>/dev/null | head -c 120; echo
LIVE=$(curl -s -m 10 "http://127.0.0.1:$POKE_PORT/api/config/public" 2>/dev/null | sed -n 's/.*"build":{"version":"\([^"]*\)".*/\1/p' | head -1)
PKG=$(sed -n 's/BUILD_VERSION="\(.*\)"/\1/p' /opt/pokemmo-report/BUILDINFO 2>/dev/null | head -1)
echo "  正在运行的代码版本：${LIVE:-取不到（服务没起来）} / 磁盘包里的：${PKG:-未标记}"
if [ -n "$LIVE" ] && [ -n "$PKG" ] && [ "${LIVE:0:7}" != "${PKG:0:7}" ]; then
  echo "  ! 跑的还是旧版：重启没生效，手动 systemctl restart poke 再看这一行"
fi
REMOTE

echo "5/5 外网可达性（只有云控制台放行了端口才会通）"
IP="${HOST#*@}"
curl -s -m 12 -o /dev/null -w "  http://$IP:$PORT/ → HTTP %{http_code}\n" "http://$IP:$PORT/api/board" \
  || echo "  不通：腾讯云控制台 → 这台服务器 → 防火墙（CVM 是安全组入方向）加 TCP $PORT"
