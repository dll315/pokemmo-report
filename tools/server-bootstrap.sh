#!/usr/bin/env bash
# 首次部署 / 重装用：在【服务器】上用 root 跑（云控制台网页终端也行）。
# 只做一件事：从你自己的 GitHub 仓库取最新提交 → 解到 /opt/pokemmo-report → 缺 Node 就装 → 建 systemd 服务 → 自检。
# 幂等，可以重复跑；不动 data/（点位、上报、机器人连接、订阅规则都在那里）。
# 以后单纯更新用 tools/server-update.sh。
set -e
REPO=dll315/pokemmo-report
SHA=$(curl -fsSL --max-time 25 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/commits/main" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)
echo "1/5 最新提交 ${SHA:-取不到，改用分支包（有缓存风险）}"
REF="${SHA:-refs/heads/main}"
OK=""
for u in "https://codeload.github.com/$REPO/tar.gz/$REF" "https://gh-proxy.com/https://codeload.github.com/$REPO/tar.gz/$REF" "https://ghproxy.net/https://codeload.github.com/$REPO/tar.gz/$REF"; do
  if curl -fsSL --max-time 90 -o /root/poke.tgz "$u"; then echo "   取到：$u"; OK=1; break; fi
  echo "   不通：$u"
done
if [ -z "$OK" ]; then echo "× 三个源都取不到包，服务器出网受限，停下来告诉我"; exit 3; fi

# 先把脚本自己单独解出来：如果服务器上是旧版，就用新版重新执行，
# 不能让 tar 覆盖掉正在被 bash 逐行读取的那个文件
tar xzf /root/poke.tgz -C /root --strip-components=1 '*/tools/server-bootstrap.sh' 2>/dev/null || true
if [ -f /root/tools/server-bootstrap.sh ] && ! cmp -s /root/tools/server-bootstrap.sh /opt/pokemmo-report/tools/server-bootstrap.sh 2>/dev/null; then
  echo "   服务器上的脚本与仓库里的不一致 → 用新版重新执行一次"
  exec bash /root/tools/server-bootstrap.sh
fi

mkdir -p /opt/pokemmo-report
tar xzf /root/poke.tgz -C /opt/pokemmo-report --strip-components=1
sed -n 's/BUILD_VERSION="\(.*\)"/2\/5 包内代码版本 \1/p' /opt/pokemmo-report/BUILDINFO
ls /opt/pokemmo-report/public/assets/sprites | wc -l | sed 's/^/   图鉴图：/'
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 16 ]; then
  echo "3/5 装 Node 20（npmmirror）"
  A=x64; if [ "$(uname -m)" = "aarch64" ]; then A=arm64; fi
  curl -fsSL -o /root/node20.tar.gz "https://registry.npmmirror.com/-/binary/node/v20.18.1/node-v20.18.1-linux-$A.tar.gz"
  mkdir -p /usr/local/node20 && tar xzf /root/node20.tar.gz -C /usr/local/node20 --strip-components=1
fi
NODE_BIN=$(if [ -x /usr/local/node20/bin/node ]; then echo /usr/local/node20/bin/node; else command -v node; fi)
echo "   解释器 $NODE_BIN → $($NODE_BIN -v)"
id poke >/dev/null 2>&1 || useradd -r -s /sbin/nologin poke
mkdir -p /opt/pokemmo-report/data && chown -R poke:poke /opt/pokemmo-report/data
printf '[Unit]\nDescription=PokeMMO 报点站\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=/opt/pokemmo-report\nEnvironment=HOST=0.0.0.0\nEnvironment=ADMIN_USER=admin\nEnvironment=ADMIN_PASSWORD=123456\nEnvironment=TZ=Asia/Shanghai\nExecStart=%s server.js 3580\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n' "$NODE_BIN" > /etc/systemd/system/poke.service
echo "4/5 启动服务"
# 端口被上一次手动跑的 node 占着是最常见的起不来，先把它清掉（只清本项目 server.js 的进程，别的不动）
HOLDER=$(ss -lntp 2>/dev/null | grep ':3580 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
MAIN=$(systemctl show -p MainPID --value poke 2>/dev/null || echo 0)
if [ -n "$HOLDER" ] && [ "$HOLDER" != "$MAIN" ] && [ "$HOLDER" != "1" ]; then
  CMD=$(tr '\0' ' ' < "/proc/$HOLDER/cmdline" 2>/dev/null || echo "")
  case "$CMD" in
    *server.js*pokemmo-report*|*pokemmo-report*server.js*)
      echo "   端口 3580 被游离进程 PID $HOLDER（$CMD）占着 → 结束它"
      kill "$HOLDER" 2>/dev/null; sleep 3
      if kill -0 "$HOLDER" 2>/dev/null; then kill -9 "$HOLDER" 2>/dev/null; fi
      ;;
    *) echo "   端口 3580 被 PID $HOLDER（${CMD:-未知}）占着，不是本项目的 node 进程，我不动它——把这一行输出发我" ;;
  esac
fi
systemctl daemon-reload && systemctl enable poke && systemctl restart poke
sleep 12
echo "5/5 自检"
journalctl -u poke -n 8 --no-pager
echo "   服务状态 $(systemctl is-active poke) · MainPID $(systemctl show -p MainPID --value poke) · 运行版本 $(curl -s -m 8 http://127.0.0.1:3580/api/config/public | sed -n 's/.*"build":{"version":"\([^"]*\)".*/\1/p')"
ss -lntp 2>/dev/null | grep ':3580 ' | sed 's/^/   监听者：/'
curl -s -m 10 -o /dev/null -w '   本机 3580 → HTTP %{http_code}\n' http://127.0.0.1:3580/api/board
