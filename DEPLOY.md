# 部署说明

两条路径，按你手上有什么机器选：

| | A. 自建服务器（推荐） | B. Pages 托管 + 你的机器跑批 |
|---|---|---|
| 看板实时性 | 默认 2 分钟同步一次 | 由你的 cron 决定（建议 5 分钟） |
| 玩家上报 / 审核 | ✅ | ❌（静态快照没有后端，入口自动隐藏） |
| 企业微信推送 | ✅ 服务端定时发 | ✅ 由跑批的那台机器发 |
| 需要 | 一台服务器 + 开一个端口 | 一个能跑 node 的地方（服务器/本机/NAS）+ GitHub |
| 数据落地 | 宿主机 `./data/db.json` | 仓库 `pages` 分支快照 + `data/db.json` |

> ⚠️ **B 不能用 GitHub Actions 抓数据**：实测上游 Cloudflare 对 Actions 出口 IP 返回 403（见 B 段）。
> 抓取必须放在能访问上游的机器上，Pages 只负责托管静态文件。

---

## A. 自建服务器（Docker 单容器）
### 0. 服务器拿不到代码时（私有仓库没配 key）

`git clone` 需要服务器上有你 GitHub 的授权；没配就会 clone 失败、`cd` 落空，
接着 `docker build` 报 `open Dockerfile: no such file or directory`。
**最快办法是在自己电脑上打包传上去**（无需服务器能访问 GitHub）：

```bash
# 在你电脑上（Git Bash）
cd /g/QoderCNworks/pokemmo-spawns
git archive --format=tar.gz -o /g/QoderCNworks/pokemmo-report.tar.gz HEAD
scp /g/QoderCNworks/pokemmo-report.tar.gz root@159.198.67.190:/root/

# 在服务器上
mkdir -p /opt/pokemmo-report
tar xzf /root/pokemmo-report.tar.gz -C /opt/pokemmo-report
ls /opt/pokemmo-report/Dockerfile        # 看到路径打印出来才算成功
```

要走 git 的话二选一：`ssh-keygen -t ed25519` 后把 `/root/.ssh/id_ed25519.pub` 加到
GitHub → Settings → SSH Keys，再 `git clone git@github.com:dll315/pokemmo-report.git`；
或者用 HTTPS + 只读令牌 `git clone https://<TOKEN>@github.com/dll315/pokemmo-report.git`
（令牌会进 shell 历史，用完记得去 GitHub 撤销）。仓库已是 **public**，直接
`git clone https://github.com/dll315/pokemmo-report.git /opt/pokemmo-report` 就行；
clone 完一定要 `ls /opt/pokemmo-report/Dockerfile` 确认目录真的有东西，
否则后面 build 只会报 `unable to prepare context: path ... not found`。

### 0b. 服务器连不上 Docker Hub（国内机器最常见的一堵墙）

现象是 `Get "https://registry-1.docker.io/v2/": context deadline exceeded`，
或者 build 卡在 `FROM node:20-alpine` 拉不下来。**这跟本仓库的代码没关系**，
是 Docker Hub 在境内被墙了。先分清哪个源能用：

```bash
for u in https://mirror.ccs.tencentyun.com/v2/ https://registry-1.docker.io/v2/ https://registry.npmmirror.com/; do
  printf "%-44s " "$u"; curl -sS -o /dev/null -m 8 -w "HTTP %{http_code}\n" "$u" || echo "不通"; done
```

腾讯云机器直接用厂商的内网加速源（不用登录、不用改 DNS，只在自己 VPC 内生效）：

```bash
mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
{ "registry-mirrors": ["https://mirror.ccs.tencentyun.com"] }
EOF
systemctl restart docker
docker pull node:20-alpine      # 拉到镜像层才算真的通了，别只看 restart 没报错
```

> 网上那些第三方公共加速源也能用，但等于把"基础镜像从谁的服务器拿"交给别人，
> 供应链上不如云厂商自己的源可信；实在要用，拉完 `docker images --digests` 核对摘要。

**上面三条都不通就别跟 Docker 耗**——本站零 npm 依赖（没有 node_modules），
第 6 节"纯 Node + systemd"跑的是同一份代码，功能完全一致，还少一层网络依赖。

### 1. 准备

```bash
# 服务器上，装好 Docker 之后
git clone git@github.com:dll315/pokemmo-report.git /opt/pokemmo-report
cd /opt/pokemmo-report

# 守卫：clone 失败（私有仓库没配 key）时这里就停，不要往下 build
test -f Dockerfile && echo "代码到位 ✓" || { echo "没拿到代码，看第 0 节"; false; }

cp .env.example .env
vi .env        # 三个值：ADMIN_USER / ADMIN_PASSWORD / WECOM_WEBHOOK
```

`.env` 已在 `.gitignore` 里，不会被提交。`TRUST_PROXY` 只在前面挂了 Nginx 反代时才设 1。

`WECOM_WEBHOOK` 可以先留空，之后在管理台网页里填也行；**一旦用环境变量注入，环境变量优先，网页里改 webhook 不会生效**（启动日志会提醒）。

### 2. 起服务

```bash
docker compose up -d --build
docker compose logs -f      # 首次启动会回填 48 小时报点，看到"同步 每 2 分钟一次"就算好了
```

访问 **`http://159.198.67.190:3580/`**，管理台 **`http://159.198.67.190:3580/admin`**，账号密码就是 .env 里那两个值。

### 2b. 不用 compose，直接 `docker run`

老机器上没装 compose 插件、或者就想一条命令跑起来时，用这个。三步：

```bash
# 1) 构建镜像（在仓库根目录，注意最后那个点）
docker build -t pokemmo-report:1.0 .

# 2) 建数据目录（宿主机上存 db.json，容器重建不丢玩家上报和历史）
mkdir -p /opt/pokemmo/data

# 3) 起容器
docker run -d \
  --name pokemmo-report \
  --restart unless-stopped \
  -p 3580:3580 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD='换成你自己的密码' \
  -e WECOM_WEBHOOK='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx' \
  -e TZ=Asia/Shanghai \
  -v /opt/pokemmo/data:/app/data \
  --memory 256m \
  pokemmo-report:1.0
```

参数为什么这么给：

| 参数 | 作用 | 不给会怎样 |
|---|---|---|
| `-p 3580:3580` | 宿主机端口映射 | 外面访问不到。换端口就改冒号左边，如 `-p 8080:3580` |
| `-e ADMIN_USER` / `-e ADMIN_PASSWORD` | 管理台登录账号与密码 | 不设则用程序默认 `admin` / `123456`（公网部署务必覆盖它）；在 .env 里把 ADMIN_PASSWORD 留空 = 禁止登录管理台 |
| `-e WECOM_WEBHOOK` | 企业微信机器人地址 | 只更新看板，不推送；也可以在管理台网页里填 |
| `-e TZ` | 容器时区 | 不影响业务时间（代码按 UTC+8 硬算北京时间），只影响日志可读性 |
| `-v /opt/pokemmo/data:/app/data` | 数据落地 | 容器一删，玩家上报和同步游标全没 |
| `--restart unless-stopped` | 开机/崩溃自启 | 服务器重启后服务不会自己起来 |
| `--memory 256m` | 上限保护 | 一般用不到（常驻内存约 60MB），留着防意外 |

日常操作：

```bash
docker logs -f pokemmo-report                # 看同步与推送日志（第一次要等 15~25 秒回填）
docker inspect -f '{{.State.Health.Status}}' pokemmo-report   # healthcheck: healthy / unhealthy
docker exec -e ADMIN_USER=admin -e ADMIN_PASSWORD=你的密码 pokemmo-report node tools/selftest.js   # 自检 58 项
docker stop pokemmo-report && docker rm pokemmo-report        # 停止并删除（数据在宿主机，不会丢）
```

更新到新版本：

```bash
git pull
docker build -t pokemmo-report:1.1 .
docker stop pokemmo-report && docker rm pokemmo-report
docker run -d --name pokemmo-report --restart unless-stopped -p 3580:3580 \
  -e ADMIN_USER='同样的账号' -e ADMIN_PASSWORD='同样的密码' -e WECOM_WEBHOOK='同样的地址' -e TZ=Asia/Shanghai \
  -v /opt/pokemmo/data:/app/data --memory 256m pokemmo-report:1.1
docker image prune -f          # 清掉旧镜像
```

备份就是一条命令（`db.json` 是唯一状态）：

```bash
cp /opt/pokemmo/data/db.json /opt/pokemmo/data/db.$(date +%F).json
```

> ⚠️ 用 `-v` 挂载后，镜像里自带的 `data/` 会被宿主机目录遮住。首次运行时机程序自己会去上游拉静态参考表（约 1.6MB），要等十几秒；如果服务器出不了网，先把本仓库的 `data/upstream/` 拷到 `/opt/pokemmo/data/upstream/` 再启动。

### 3. 放行端口

阿里云/腾讯云要在**安全组**放行 TCP 3580（仅建议限制来源 IP 或加口令），系统层再确认：

```bash
firewall-cmd --add-port=3580/tcp --permanent && firewall-cmd --reload     # CentOS/Rocky
ufw allow 3580/tcp                                                        # Ubuntu
```

> 如果打印 `FirewallD is not running`：系统层本来就没开防火墙，这两条不用管，
> 端口只在**云控制台的防火墙/安全组**这一道。腾讯云轻量服务器在
> 「控制台 → 防火墙」加 TCP 3580，CVM 在「安全组 → 入方向」加。
> 外网 `curl -sI http://服务器IP:3580/` 不通而 `curl -sI http://127.0.0.1:3580/` 通，就是这里没放行。

为什么用 3580 这种非标端口：国内云厂商对 **80/443** 会检查 ICP 备案，未备案的域名解析到国内机器提供网页服务有被阻断风险。直连非标端口最省事。
真要绑域名（例如 `poke.你的域名.com`），需要先完成备案，再走下面第 5 步的反代。

### 4. 更新与备份

```bash
git pull
docker compose up -d --build

# 备份：db.json 里有玩家上报和审核记录
cp data/db.json data/db.json.bak-$(date +%F)
```

`./data` 是 bind mount，重建镜像不丢数据。上游静态参考表也在 `data/upstream/`，12 小时自动刷一次。

### 5. 可选：Nginx 反代

已经装了 Nginx 的话，挂到某个域名下的子路径不如直接给个子域名干净：

```nginx
server {
  listen 80;
  server_name poke.example.com;          # 国内机器需已备案
  location / {
    proxy_pass http://127.0.0.1:3580;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

走反代后，玩家上报的限频按 IP 计算会失真，记得给容器加环境变量 `TRUST_PROXY=1`（只信任 X-Forwarded-For 的第一段）。

### 6. 不装 Docker：纯 Node + systemd（国内服务器更省事的一条）

本站**没有任何 npm 依赖**（`src/net.js` 用 Node 自带的 `https` 模块），
所以只要有 node 可执行文件就能跑：不用 `npm install`，不用 Docker Hub，不用镜像源。
服务本身要 Node 16+（`tools/` 里的自检脚本用了全局 `fetch`，那个要 18+）。

```bash
# 1) 代码到位（第 0 节：本机打包 scp 上来）
mkdir -p /opt/pokemmo-report && tar xzf /root/pokemmo-report.tar.gz -C /opt/pokemmo-report
ls /opt/pokemmo-report/server.js /opt/pokemmo-report/data/cn-species.json   # 看得见才继续

# 2) 要一个 ≥16 的 node。发行版自带的太老就从 npmmirror 取官方二进制，不动系统包
node -v 2>/dev/null || dnf install -y nodejs
[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 16 ] && {
  A=$(uname -m); [ "$A" = "aarch64" ] && A=arm64 || A=x64
  curl -L -o /root/node20.tar.gz "https://registry.npmmirror.com/-/binary/node/v20.18.1/node-v20.18.1-linux-$A.tar.gz"
  mkdir -p /usr/local/node20 && tar xzf /root/node20.tar.gz -C /usr/local/node20 --strip-components=1
}
NODE_BIN=$([ -x /usr/local/node20/bin/node ] && echo /usr/local/node20/bin/node || command -v node)
echo "用的解释器：$NODE_BIN"; $NODE_BIN -v

# 3) 跑成一个服务账号（只有 data/ 需要写权限）
id poke >/dev/null 2>&1 || useradd -r -s /sbin/nologin poke
mkdir -p /opt/pokemmo-report/data && chown -R poke:poke /opt/pokemmo-report/data

# 4) systemd 单元（ADMIN_PASSWORD 那行必须改；密码里别带空格和 #）
cat > /etc/systemd/system/poke.service <<EOF
[Unit]
Description=PokeMMO 报点站
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/pokemmo-report
Environment=HOST=0.0.0.0
Environment=ADMIN_USER=admin
Environment=ADMIN_PASSWORD=换成你自己的密码
Environment=WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人key
Environment=TZ=Asia/Shanghai
ExecStart=${NODE_BIN} server.js 3580
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now poke
```

`WECOM_WEBHOOK` 那行不需要就先删掉，之后在管理台网页里填（写进 unit 的话环境变量优先，网页改了不生效）。

验证与日常操作：

```bash
journalctl -u poke -n 40 --no-pager                                  # 首启会回填 48 小时报点，十几秒
curl -s http://127.0.0.1:3580/api/board | head -c 200                 # 本机通就说明服务活着
systemctl restart poke                                                # 改完 unit 先 systemctl daemon-reload
```

更新版本：重新打包 scp 上来解包覆盖（`db.json`/`config.json` 不在打包里，不会被动），
再 `systemctl restart poke`。备份还是那一份 `data/db.json`：

```bash
cp /opt/pokemmo-report/data/db.json /opt/pokemmo-report/data/db.$(date +%F).json
```

---

## B. GitHub Pages（能托管，但要注意上游拦 Actions）

**实测结论先说**：Pages 的托管、部署、访问都正常；但 `alpha.pokemmotools.org` 的 Cloudflare
会拒绝 GitHub Actions 的出口 IP——第一次跑批时 `/history` 与全部 `/api/*` 一律 **HTTP 403**，
一条数据都抓不到。因此"Actions 定时抓上游"这条路当前不可行，除非上游哪天放行。
（`node tools/probe-upstream.js` 就是用来确认这件事的，日志里有 `cf-ray` 与状态码。）

两条路可选：

| | B1 Actions 全自动 | **B2 你的机器抓 + Pages 托管（可行，推荐）** |
|---|---|---|
| 谁抓数据 | GitHub Actions | 你的服务器或本机（住宅/云主机 IP 能过） |
| 谁部署 | Actions deploy-pages | push 到 `pages` 分支，Pages 分支托管 |
| 谁推送企业微信 | Actions | 同样由跑批的那台机器发 |
| 上游 403 影响 | 全瞎 | 无影响 |

### B2 部署步骤

1. **仓库设置**：`Settings → Pages → Source: Deploy from a branch`，分支选 **`pages`**、目录 **`/ (root)`**。
   （命令行版：`gh api -X POST repos/<你>/pokemmo-report/pages -f 'source[branch]=pages' -f 'source[path]=/'`）
2. **首次发布**（在能访问上游的机器上，仓库根目录）：

```bash
node tools/publish-pages.js        # 抓 data/ 里的数据 → 生成 dist/ → 推到 pages 分支
```

   它会打印 `已推送 origin/pages`。等 30~60 秒，地址是 `https://<用户名>.github.io/<仓库名>/`。
3. **定时跑**（cron，每 5 分钟一次；抓取和推送一起做）：

```bash
crontab -l 2>/dev/null | grep -v publish-pages.js > /tmp/ct; cat >> /tmp/ct <<'EOF'
*/5 * * * * cd /opt/pokemmo-report && WECOM_WEBHOOK='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' node tools/actions-sync.js && node tools/publish-pages.js --skip-build >> /var/log/poke-pages.log 2>&1
EOF
crontab /tmp/ct && rm -f /tmp/ct
```

   注意上面这条用的是 `state/db.json`（`actions-sync.js` 默认写 `state/`），而 `publish-pages.js` 默认读 `data/`。
   二选一定居：**要么**只用 `data/`（那就把 `--data=data` 传给 actions-sync：`STATE_DIR=data node tools/actions-sync.js`），
   **要么**只用 `state/`（那就 `node tools/publish-pages.js --skip-build` 前先 `node tools/build-static.js --data=state`）。
   推荐前者，和自建服务器路径共用同一份库。
4. **验证**：浏览器开 Pages 地址，看板应有点位；`curl -s <地址>/data.json | head -c 200` 能看到
   `generatedAt` 在刷新；每次跑完 `git fetch && git log --oneline origin/pages -1` 应有新提交。
5. **不要和 A 段同时开推送**（两处都会往同一个群发，会重复）。只在服务器跑服务、Pages 当纯展示镜像时，
   把 `WECOM_WEBHOOK` 只给服务器那条，cron 那条留空即可只更新网页。

### B1 如果哪天上游放行 Actions

仓库 `Settings → Secrets and variables → Actions → Variables` 加 `PAGES_VIA_ACTIONS=1`，
工作流 `同步快照并推送` 就会恢复：抓上游 → 回写 `state/db.json` → 部署 Pages → 推企业微信。
Secrets 里配 `WECOM_WEBHOOK`，Variables 里可选 `PUSH_KINDS` / `PUSH_ONLY` / `PUSH_EXCEPT` / `PUSH_REGIONS` /
`PUSH_MIN_TIER` / `PUSH_MAX` / `PUSH_ENABLED=0` / `BACKFILL_HOURS`。关掉变量即回到 B2。

### Pages 路径的固有代价

- 静态快照**没有**上报与审核，页面上报入口会自动隐藏；点位上报必须走自建服务器那条。
- 倒计时按浏览器本地时间算，两次跑批之间数字是陈的（间隔 5 分钟就只能保证 5 分钟内新鲜）。
- Pages 在国内可达性一般，访问偶发慢或连不上属正常。
- 私有仓库的 Pages 站点内容仍是**公开可访问**的（你的套餐可以开私有仓库 + Pages，但网页本身不私密）。

---

## 企业微信侧注意

- 群机器人限速约 **20 条/分钟**，所以每轮同步最多发 `maxPerTick` 条（默认 4），超出的留在队列里下轮发。
- markdown 消息上限 **4096 字节**，代码里已做截断。
- 支持的颜色只有 `info / comment / warning`，别的会退成默认色。
- 发送失败不推进队列，重试 5 次后丢弃并记日志；点位过期也会静默丢弃（不再打扰）。
- 换群就是换 webhook 地址；建议先建个测试群跑几天。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 看板一直空 | 那个时段确实没人报点（上游 Alpha 报点每天集中在 4 个时段）。用 `tools/demo-events.js` 造数据验证界面。 |
| `会话就绪` 之后 totalRows=0 | 上游令牌与会话 cookie 绑定，代码已自动重建会话重试；持续失败说明上游改了页面结构，检查 `src/upstream.js` 里 `history-api-token` 的正则。 |
| 日志出现 `429 / HTTP 5xx` | 抓得太急。把同步间隔调到 5 分钟以上。 |
| 中文名显示成英文 | `data/cn-species.json` / `cn-locations.json` 没进容器（`.dockerignore` 别把它们排除），或管理台点「重载词表」。 |
| 小图标不显示、只剩首字圆徽 | `public/assets/sprites/` 没被打进去（483 张共 0.36MB，正常随仓库走）。补一次：`npm run sprites`，它按 `data/sprite-manifest.json` 里的 git blob SHA 逐张校验后才落盘。 |
| 推送 errcode 93000 | webhook key 不对（机器人被移出群或复制错）。 |
| 上报提交后看不到 | 默认要管理员在 `/admin` 放行；想直发就关掉「上报需人工审核」。 |
| 想重灌历史 | 停服务后 `node tools/reseed.js 168 --force`（容器里 `docker compose exec report node tools/reseed.js 168 --force`，注意先 `-e` 停调度）。 |
| Actions 跑批报 `HTTP 403`、库存 0 | 上游 Cloudflare 拦数据中心 IP，不是代码问题。改走 DEPLOY.md 的 B2（你的机器跑批 + Pages 分支托管），用 `node tools/probe-upstream.js` 确认。 |
| build 报 `unable to prepare context: path "/opt/pokemmo-report" not found` | 那个目录根本不存在／是空的——clone 没成功就往下的命令全跑了一遍。`ls /opt/pokemmo-report/Dockerfile` 确认代码到位，取不到代码看第 0 节。 |
| `Get "https://registry-1.docker.io/v2/": context deadline exceeded` | Docker Hub 在境内连不上，跟本站代码无关。第 0b 节配加速源，或者干脆走第 6 节纯 Node（零依赖，不需要任何镜像）。 |
| `FirewallD is not running` | 系统层防火墙本来就没开，`firewall-cmd` 那两条不用管；端口只剩云控制台「防火墙/安全组」一道，见第 3 节。 |
