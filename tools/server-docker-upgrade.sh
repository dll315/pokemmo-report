#!/usr/bin/env bash
# 在【服务器】上用 root 跑：把正在跑的 pokemmo-report 容器升级到仓库最新代码，
# 并且**原样继承现有容器的挂载与环境变量**（机器人地址、上报记录都在挂载目录里）。
#
#   bash server-docker-upgrade.sh
#
# 安全设计：
#   - 先取代码、先 build，build 失败就到此为止，旧容器不受任何影响；
#   - 确认现有容器把 /app/data 挂在宿主机上才敢删旧容器，否则直接停手（不然数据随容器一起没了）；
#   - 旧镜像保留为 pokemmo-report:rollback，回滚只要一条 docker run。
set -euo pipefail

REPO="dll315/pokemmo-report"
NAME="pokemmo-report"
DIR="/opt/pokemmo-report"
PORT="3580"

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
echo "   环境 ${#ENVS[@]} 个：$(printf '%s ' "${ENVS[@]:-}" | sed -E 's/(key=)[^&[:space:]]+/\1***/g')"
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

echo "4/5 换容器"
ARGS=()
for m in "${MNTS[@]}"; do ARGS+=(-v "$m"); done
for e in "${ENVS[@]:-}"; do [ -n "$e" ] && ARGS+=(-e "$e"); done
docker update --restart=no "$NAME"
docker stop "$NAME"
docker rm "$NAME"
docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:$PORT" --memory 256m "${ARGS[@]}" "$NAME:new"

echo "5/5 自检"
sleep 15
docker ps --filter "name=$NAME" --format '{{.Status}}'
docker logs --tail 12 "$NAME"
curl -s -m 8 "http://127.0.0.1:$PORT/api/config/public" | head -c 200; echo
echo "   浏览器打开 http://$(curl -s -m 5 ifconfig.me 2>/dev/null || echo 服务器IP):$PORT/admin ，标题下应显示上面 build 里的版本号"
echo "   回滚：docker stop $NAME && docker rm $NAME && docker run -d --name $NAME --restart unless-stopped -p $PORT:$PORT --memory 256m ${MNTS[*]/#/-v } $NAME:rollback"
