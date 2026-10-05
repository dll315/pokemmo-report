#!/usr/bin/env bash
# 在【服务器上】用 root 跑：从你自己的 GitHub 仓库拉最新提交，覆盖代码目录，重启服务并自检。
# 适用于本机连不上服务器 22 端口、只能在云控制台网页终端里操作的情况。
#
#   bash server-update.sh --check    # 只探测"能不能取到代码、线上跑的是哪版"，什么都不改
#   bash server-update.sh            # 真的更新：备份 → 解包 → 重启 → 自检
#
# 只覆盖代码。data/（db.json 点位与上报、config.json 机器人与订阅规则）不在仓库包里，不会被动。
set -euo pipefail

REPO="dll315/pokemmo-report"
DIR="${POKE_DIR:-/opt/pokemmo-report}"
PORT="${POKE_PORT:-3580}"
TMP="/tmp/pokemmo-report.tgz"
LIST="/tmp/pokemmo-report-list.txt"
CHECK_ONLY=""
if [ "${1:-}" = "--check" ]; then CHECK_ONLY=1; fi

echo "1/6 确认仓库最新的提交号"
SHA=""
for api in "https://api.github.com/repos/$REPO/commits/main" "https://gh-proxy.com/https://api.github.com/repos/$REPO/commits/main"; do
  got="$(curl -fsSL --max-time 25 -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)"
  if [ -n "$got" ]; then SHA="$got"; echo "  main = $SHA"; break; fi
done
if [ -z "$SHA" ]; then
  echo "  ! 取不到提交号，退回按分支名取包。GitHub 对分支包有缓存，可能拿到旧版（这次会照样告诉你包里是哪个提交）"
fi

SRC_LIST=()
if [ -n "$SHA" ]; then
  SRC_LIST=("https://codeload.github.com/$REPO/tar.gz/$SHA" "https://gh-proxy.com/https://codeload.github.com/$REPO/tar.gz/$SHA")
fi
SRC_LIST+=("https://codeload.github.com/$REPO/tar.gz/refs/heads/main" "https://gh-proxy.com/https://codeload.github.com/$REPO/tar.gz/refs/heads/main" "https://ghproxy.net/https://codeload.github.com/$REPO/tar.gz/refs/heads/main")

echo "2/6 取代码（按顺序试 ${#SRC_LIST[@]} 个源）"
GOT=""
for url in "${SRC_LIST[@]}"; do
  if curl -fsSL --max-time 90 -o "$TMP" "$url" 2>/dev/null && [ -s "$TMP" ]; then
    echo "  成功：$url"
    GOT="$url"
    break
  fi
  echo "  不通：$url"
done
if [ -z "$GOT" ]; then echo "× 所有源都取不到代码。服务器出网被限制的话，只能从你本机传包（见 DEPLOY.md 第 0 节）"; exit 3; fi

echo "3/6 校验包内容"
gzip -t "$TMP" || { echo "× 下载到的不是合法 gzip"; exit 1; }
tar tzf "$TMP" >"$LIST" 2>/dev/null || { echo "× tar 读不了这个包"; exit 1; }
ENTRIES=$(wc -l <"$LIST")
if ! grep -q '/server.js$' "$LIST"; then echo "× 包里没有 server.js，不像本仓库的包，放弃"; exit 1; fi
if ! [ "$ENTRIES" -gt 400 ]; then echo "× 条目太少（$ENTRIES），不像完整仓库，放弃"; exit 1; fi
SPRITES=$(grep -c '/public/assets/sprites/[0-9]*\.png$' "$LIST" || true)
BI_MEMBER=$(grep -m1 'BUILDINFO$' "$LIST" || true)
PKG_VER=""
if [ -n "$BI_MEMBER" ]; then
  PKG_VER=$(tar xzOf "$TMP" "$BI_MEMBER" 2>/dev/null | sed -n 's/BUILD_VERSION="\(.*\)"/\1/p' | head -1)
  case "$PKG_VER" in *'$Format'*) PKG_VER="" ;; esac
fi
echo "  $(wc -c <"$TMP") 字节 / $ENTRIES 个条目 / 图鉴图 $SPRITES 张 / 包内版本 ${PKG_VER:-未标记}"
if [ -n "$SHA" ] && [ -n "$PKG_VER" ] && [ "${SHA:0:7}" != "${PKG_VER:0:7}" ]; then
  echo "  ! 包里是 $PKG_VER，而仓库最新是 ${SHA:0:7} —— 你拿到的是缓存的旧包（GitHub 对分支名打包有缓存）"
fi

LIVE_VER=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/config/public" 2>/dev/null | sed -n 's/.*"build":{"version":"\([^"]*\)".*/\1/p' | head -1)
echo "  当前正在运行的服务版本：${LIVE_VER:-（取不到：服务没起来，或它不是从打包目录跑的）}"

if [ -n "$CHECK_ONLY" ]; then
  echo "√ 只探测模式：什么都没改。去掉 --check 再跑一次就会真的更新。"
  exit 0
fi

echo "4/6 更新 $DIR（先整目录备份成 $DIR.prev）"
if [ -d "$DIR" ]; then
  rm -rf "$DIR.prev"
  cp -a "$DIR" "$DIR.prev"
  echo "  已备份，回滚：cp -a $DIR.prev/. $DIR/ && systemctl restart poke"
else
  mkdir -p "$DIR"
  echo "  $DIR 原本不存在，按首次部署处理（还要建服务，见第 6 步提示）"
fi
tar xzf "$TMP" -C "$DIR" --strip-components=1
if ! [ -f "$DIR/server.js" ]; then echo "× 解包后没看到 server.js"; exit 1; fi
mkdir -p "$DIR/data"
if id poke >/dev/null 2>&1; then chown -R poke:poke "$DIR/data"; fi
ls "$DIR"/public/assets/sprites 2>/dev/null | wc -l | sed 's/^/  现在代码里的图鉴图：/'

echo "5/6 重启"
MODE=""
if [ -f /etc/systemd/system/poke.service ]; then MODE=systemd; fi
if [ -z "$MODE" ] && command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx pokemmo-report; then MODE=docker; fi
case "$MODE" in
  systemd) systemctl daemon-reload; systemctl restart poke; sleep 10; journalctl -u poke -n 12 --no-pager ;;
  docker)
    echo "  你是 Docker 部署：代码换了必须重建镜像才生效。境内机器拉不到 Docker Hub，"
    echo "  基础镜像已在本地的话执行："
    echo "    cd $DIR && docker build -t pokemmo-report:latest . && docker restart pokemmo-report"
    ;;
  *) echo "  ! 没找到 poke.service 也没找到 pokemmo-report 容器：代码已就位，但还没有服务在跑。"
     echo "    首次部署请按 DEPLOY.md 第 6 节建 systemd 单元（本脚本不替你创建服务）" ;;
esac

echo "6/6 自检"
curl -s -m 10 -o /dev/null -w "  服务器本机 127.0.0.1:$PORT → HTTP %{http_code}\n" "http://127.0.0.1:$PORT/api/board" \
  || echo "  × 端口 $PORT 没在监听：服务没起来，先看上面 journalctl，别去查防火墙"
NEW_LIVE=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/config/public" 2>/dev/null | sed -n 's/.*"build":{"version":"\([^"]*\)".*/\1/p' | head -1)
echo "  更新前运行版本 ${LIVE_VER:-无} → 更新后运行版本 ${NEW_LIVE:-无}（包里是 ${PKG_VER:-未标记}）"
if [ -n "$NEW_LIVE" ] && [ -n "$PKG_VER" ] && [ "${NEW_LIVE:0:7}" != "${PKG_VER:0:7}" ]; then
  echo "  ! 跑的还是旧版：重启没生效。执行 systemctl restart poke 再看这一行"
fi
echo "  外网打不开而本机通 = 云控制台防火墙/安全组没放行 TCP $PORT"
