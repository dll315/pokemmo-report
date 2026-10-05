#!/usr/bin/env bash
# 在【服务器】上用 root 跑：把正在跑的 pokemmo-report 容器升级到仓库最新代码，
# 并且**原样继承现有容器的挂载与环境变量**（机器人地址、上报记录都在挂载目录里）。
#
#   bash server-docker-upgrade.sh                 # 升级，账号密码等环境原样继承
#   bash server-docker-upgrade.sh --reset-admin   # 升级，并把账号强制改回 admin / 123456
#
# 加 --reset-admin 的场景：早期起容器时 -e 了一个自己定的密码，之后每次升级都继承下来，
# 而环境变量优先级高于 data/config.json，于是管理台里改密码"不生效"。
#
# 安全设计：
#   - 先取代码、先 build，build 失败就到此为止，旧容器不受任何影响；
#   - 确认现有容器把 /app/data 挂在宿主机上才动手（否则停手，不然数据随容器一起没了）；
#   - **旧容器只改名不删除**（pokemmo-report-old），新容器 HTTP 200 验证通过才 rm 它；
#     中途任何失败都会把旧容器恢复原名并 start 回去，站点不会停着不管；
#   - 旧镜像同时留一份 pokemmo-report:rollback 标签。
set -euo pipefail

REPO="dll315/pokemmo-report"
NAME="pokemmo-report"
DIR="/opt/pokemmo-report"
PORT="3580"
RESET_ADMIN=""
if [ "${1:-}" = "--reset-admin" ]; then RESET_ADMIN=1; fi

echo "1/5 取最新代码（按 main 的提交号取，避开 GitHub 的分支包缓存）"
SHA="$(curl -fsSL --max-time 25 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)"
REF="${SHA:-refs/heads/main}"
echo "   main = ${SHA:-取不到，改用分支包}"
OK=""
for u in "https://codeload.github.com/$REPO/tar.gz/$REF" "https://gh-proxy.com/https://codeload.github.com/$REPO/tar.gz/$REF" "https://ghproxy.net/https://codeload.github.com/$REPO/tar.gz/$REF"; do
  if curl -fsSL --max-time 90 -o /root/pokemmo-report.tgz "$u" 2>/dev/null && [ -s /root/pokemmo-report.tgz ]; then echo "   取到：$u"; OK=1; break; fi
  echo "   不通：$u"
done
if [ -z "$OK" ]; then echo "× 取不到代码"; exit 3; fi
mkdir -p "$DIR"
tar xzf /root/pokemmo-report.tgz -C "$DIR" --strip-components=1
sed -n 's/BUILD_VERSION="\(.*\)"/   新代码版本 \1/p' "$DIR/BUILDINFO"

echo "2/5 读现有容器的挂载与环境"
if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "   没有叫 $NAME 的容器（可能已经删了）。那就不需要继承参数，直接按 DEPLOY.md 第 2b 节 docker run 一次"
  exit 0
fi
mapfile -t MNTS < <(docker inspect -f '{{range .Mounts}}{{.Source}}:{{.Destination}}{{println}}{{end}}' "$NAME")
mapfile -t ENVS < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | grep -vE '^(PATH|HOME|NODE_ENV|container)=') || true
echo "   挂载 ${#MNTS[@]} 个：${MNTS[*]:-（无）}"
echo "   环境 ${#ENVS[@]} 个：$(printf '%s ' "${ENVS[@]:-}" | sed -E 's/(key=)[^&[:space:]]+/\1***/g; s/(ADMIN_PASSWORD=).*/\1***/')"
# 继承来的 ADMIN_* 会盖掉 data/config.json 里的设置（环境变量优先级最高），
# 而且 docker 的 -e 是"后面覆盖前面"，所以这里必须让它显式可见，不能悄悄带过去。
for e in "${ENVS[@]:-}"; do
  case "$e" in
    ADMIN_PASSWORD=*) echo "   ! 旧容器带着 ADMIN_PASSWORD（${#e} 位含前缀），登录用的是它、不是 config.json 里那个。要改回默认请加 --reset-admin" ;;
    ADMIN_USER=*) echo "   ! 旧容器带着 $e" ;;
  esac
done
HAS_DATA=""
for m in "${MNTS[@]:-}"; do case "$m" in *:/app/data*) HAS_DATA=1 ;; esac; done
if [ -z "$HAS_DATA" ]; then
  echo "× 现有容器没有把 /app/data 挂到宿主机 —— 删容器会连机器人地址、玩家上报、同步游标一起没掉。"
  echo "  我停在这里不动手。要先把数据救出来可以：docker cp $NAME:/app/data /opt/pokemmo/data  然后重跑本脚本"
  exit 4
fi

echo "3/5 构建新镜像（旧镜像先留一份做回滚）"
docker tag "$NAME:latest" "$NAME:rollback" 2>/dev/null || echo "   （没有 $NAME:latest 这个标签，跳过回滚标签）"
docker build -t "$NAME:new" "$DIR"

echo "4/5 换容器（旧容器改名留着，新容器验证通过才删）"
if [ -n "$RESET_ADMIN" ]; then
  KEEP=()
  for e in "${ENVS[@]:-}"; do
    if [ -z "$e" ]; then continue; fi
    case "$e" in
      ADMIN_USER=*|ADMIN_PASSWORD=*) echo "   丢掉继承来的 ${e%%=*}（改用默认 admin / 123456）" ;;
      *) KEEP+=("$e") ;;
    esac
  done
  ENVS=("${KEEP[@]:-}")
fi
ARGS=()
for m in "${MNTS[@]}"; do ARGS+=(-v "$m"); done
for e in "${ENVS[@]:-}"; do if [ -n "$e" ]; then ARGS+=(-e "$e"); fi; done
if [ -n "$RESET_ADMIN" ]; then ARGS+=(-e ADMIN_USER=admin -e ADMIN_PASSWORD=123456); fi
OLD="$NAME-old"
docker rm -f "$OLD" >/dev/null 2>&1 || true
if ! docker rename "$NAME" "$OLD"; then echo "× 改不出 $OLD，停手（旧容器原样在跑）"; exit 5; fi
docker update --restart=no "$OLD" >/dev/null
docker stop "$OLD" >/dev/null
restore_old() {
  echo "→ 先把旧容器恢复回去"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rename "$OLD" "$NAME" 2>/dev/null || true
  docker update --restart=unless-stopped "$NAME" >/dev/null 2>&1 || true
  docker start "$NAME" >/dev/null 2>&1 || true
  docker ps --filter "name=$NAME" --format '已恢复：{{.Names}} | {{.Status}}'
}
if ! docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:$PORT" --memory 256m "${ARGS[@]}" "$NAME:new"; then
  echo "× 新容器启动失败"
  restore_old
  exit 6
fi
sleep 15
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/board" || echo 000)
if [ "$CODE" != "200" ]; then
  echo "× 新容器起来了但 $PORT 没答 200（HTTP $CODE），日志："
  docker logs --tail 20 "$NAME" 2>&1 | tail -20
  restore_old
  exit 7
fi
docker rm "$OLD" >/dev/null && echo "   新容器已验证通过，旧容器 $OLD 删除（镜像 $NAME:rollback 仍留着）"

echo "5/5 自检"
sleep 15
docker ps --filter "name=$NAME" --format '{{.Status}}'
docker logs --tail 12 "$NAME"
curl -s -m 8 "http://127.0.0.1:$PORT/api/config/public" | head -c 200; echo
echo "   浏览器打开 http://$(curl -s -m 5 ifconfig.me 2>/dev/null || echo 服务器IP):$PORT/admin ，标题下应显示上面 build 里的版本号"
echo "   回滚：docker stop $NAME && docker rm $NAME && docker run -d --name $NAME --restart unless-stopped -p $PORT:$PORT --memory 256m ${MNTS[*]/#/-v } $NAME:rollback"
