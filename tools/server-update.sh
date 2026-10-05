#!/usr/bin/env bash
# 在【服务器上】用 root 跑：从你自己的 GitHub 仓库拉最新 main，覆盖代码目录，重启服务并自检。
# 适用于本机连不上服务器 22 端口、只能在云控制台网页终端里操作的情况。
#
#   bash server-update.sh --check    # 只探测"能不能取到代码"，什么都不改（先跑这个）
#   bash server-update.sh            # 真的更新：备份 → 解包 → 重启 → 自检
#
# 只覆盖代码。data/（db.json 点位与上报、config.json 机器人与订阅规则）不在仓库包里，不会被动。
set -euo pipefail

REPO="dll315/pokemmo-report"
DIR="${POKE_DIR:-/opt/pokemmo-report}"
PORT="${POKE_PORT:-3580}"
TMP="/tmp/pokemmo-report.tgz"
CHECK_ONLY=""
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; fi

SRC_LIST=(
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  "https://gh-proxy.com/https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
  "https://ghproxy.net/https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
)

echo "1/5 取代码（按顺序试 ${#SRC_LIST[@]} 个源）"
GOT=""
for url in "${SRC_LIST[@]}"; do
  if curl -fsSL --max-time 90 -o "$TMP" "$url" 2>/dev/null && [ -s "$TMP" ]; then
    echo "  成功：$url"
    GOT="$url"
    break
  fi
  echo "  不通：$url"
done
[ -n "$GOT" ] || { echo "× 三个源都取不到代码。服务器出网被限制的话，只能从你本机传包（见 DEPLOY.md 第 0 节）"; exit 3; }

echo "2/5 校验包内容（要能列出 server.js 和图鉴图目录）"
gzip -t "$TMP" || { echo "× 下载到的不是合法 gzip"; exit 1; }
tar tzf "$TMP" >/tmp/poke-list.txt 2>/dev/null || { echo "× tar 读不了这个包"; exit 1; }
ENTRIES=$(wc -l </tmp/poke-list.txt)
grep -q '/server.js$' /tmp/poke-list.txt || { echo "× 包里没有 server.js，不像本仓库的包，放弃"; exit 1; }
SPRITES=$(grep -c '/public/assets/sprites/[0-9]*\.png$' /tmp/poke-list.txt || true)
SIZE=$(wc -c <"$TMP")
echo "  $SIZE 字节 / $ENTRIES 个条目 / 图鉴图 $SPRITES 张"
[ "$ENTRIES" -gt 400 ] || { echo "× 条目太少（<400），不像完整仓库，放弃"; exit 1; }

if [ -n "$CHECK_ONLY" ]; then
  echo "√ 只探测模式：能取到代码，什么都没改。去掉 --check 再跑一次就会真的更新。"
  exit 0
fi

echo "3/5 更新 $DIR（先备份成 $DIR.prev）"
if [ -d "$DIR" ]; then
  rm -rf "$DIR.prev"
  cp -a "$DIR" "$DIR.prev"
  echo "  已备份旧代码，回滚：cp -a $DIR.prev/. $DIR/ && systemctl restart poke"
else
  mkdir -p "$DIR"
  echo "  $DIR 原本不存在，按首次部署处理（还要建服务，见第 5 步提示）"
fi
tar xzf "$TMP" -C "$DIR" --strip-components=1
test -f "$DIR/server.js" || { echo "× 解包后没看到 server.js"; exit 1; }
mkdir -p "$DIR/data"
if id poke >/dev/null 2>&1; then chown -R poke:poke "$DIR/data"; fi
ls "$DIR"/public/assets/sprites | wc -l | sed 's/^/  现在代码里的图鉴图：/'

echo "4/5 重启"
MODE=""
if [ -f /etc/systemd/system/poke.service ]; then MODE=systemd; fi
if [ -z "$MODE" ] && command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx pokemmo-report; then MODE=docker; fi
case "$MODE" in
  systemd) systemctl daemon-reload; systemctl restart poke; sleep 10; journalctl -u poke -n 10 --no-pager ;;
  docker)
    echo "  你是 Docker 部署：代码换了必须重建镜像才生效。境内机器拉不到 Docker Hub，"
    echo "  如果之前那次 build 能成功（基础镜像已在本地），执行："
    echo "    cd $DIR && docker build -t pokemmo-report:latest . && docker restart pokemmo-report"
    ;;
  *) echo "  ! 没找到 poke.service 也没找到 pokemmo-report 容器：代码已就位，但还没有服务在跑。"
     echo "    首次部署请按 DEPLOY.md 第 6 节建 systemd 单元（本脚本不替你创建服务）" ;;
esac

echo "5/5 自检"
curl -s -m 10 -o /dev/null -w "  服务器本机 127.0.0.1:$PORT → HTTP %{http_code}\n" "http://127.0.0.1:$PORT/api/board" \
  || echo "  × 端口 $PORT 没在监听：服务没起来，先看上面 journalctl，别去查防火墙"
curl -s -m 10 "http://127.0.0.1:$PORT/api/board" 2>/dev/null | head -c 140; echo
echo "  外网打不开而本机通 = 云控制台防火墙/安全组没放行 TCP $PORT"
