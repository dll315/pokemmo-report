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
git clone https://github.com/dll315/pokemmo-report.git /opt/pokemmo-report
cd /opt/pokemmo-report

# 守卫：clone 失败时目录是空的，这里就停，不要往下 build
test -f Dockerfile && echo "代码到位 ✓" || { echo "没拿到代码，看第 0 节"; false; }

cp .env.example .env
vi .env        # 只有两个值：ADMIN_USER=admin / ADMIN_PASSWORD=123456
```

`.env` 已在 `.gitignore` 里，不会被提交。`TRUST_PROXY` 只在前面挂了 Nginx 反代时才设 1。

**企业微信机器人不要写进 `.env`**：设了它，管理台的连接列表里会多出一条**锁定**记录（改不动、删不掉）。留空，起站后在「企业微信机器人」里添加，想加几个群就加几条。

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

# 3) 起容器（账号 admin、密码 123456；机器人地址起站后在管理台「企业微信机器人」里添加）
docker run -d \
  --name pokemmo-report \
  --restart unless-stopped \
  -p 3580:3580 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=123456 \
  -e TZ=Asia/Shanghai \
  -v /opt/pokemmo/data:/app/data \
  --memory 256m \
  pokemmo-report:1.0
```

参数为什么这么给：

| 参数 | 作用 | 不给会怎样 |
|---|---|---|
| `-p 3580:3580` | 宿主机端口映射 | 外面访问不到。换端口就改冒号左边，如 `-p 8080:3580` |
| `-e ADMIN_USER=admin` / `-e ADMIN_PASSWORD=123456` | 管理台登录账号与密码 | 不设也是这一对（程序默认值），写出来只是让你看清 |
| `-e TZ` | 容器时区 | 不影响业务时间（代码按 UTC+8 硬算北京时间），只影响日志可读性 |
| `-v /opt/pokemmo/data:/app/data` | 数据落地 | 容器一删，玩家上报、同步游标和你填的机器人地址全没 |
| `--restart unless-stopped` | 开机/崩溃自启 | 服务器重启后服务不会自己起来 |
| `--memory 256m` | 上限保护 | 一般用不到（常驻内存约 60MB），留着防意外 |

**这里没有 `WECOM_WEBHOOK` 是有意的**：设了它就会在管理台的连接列表里多出一条**锁定**记录（改不动、删不掉），机器人地址统一在网页里管更省事。

日常操作：

```bash
docker logs -f pokemmo-report                # 看同步与推送日志（第一次要等 15~25 秒回填）
docker inspect -f '{{.State.Health.Status}}' pokemmo-report   # healthcheck: healthy / unhealthy
docker exec -e ADMIN_USER=admin -e ADMIN_PASSWORD=123456 pokemmo-report node tools/selftest.js   # 自检 84 项
docker stop pokemmo-report && docker rm pokemmo-report        # 停止并删除（数据在宿主机，不会丢）
```

> 以后**升级别照抄上面这条 `docker rm`**，那是手工重建容器、会连带删掉旧容器。用第 4.1 节那条脚本，
> 它先 build、旧容器只改名、新容器验到 HTTP 200 才删，失败当场恢复。
> 也别用 `docker restart` 当更新——镜像不重建就还是旧代码，管理台看着"没变化"就是这个原因。

更新到新版本：

```bash
# 在你电脑上：打包传上去（服务器直连 GitHub 不通，见第 0 节）
git archive --format=tar.gz -o /g/QoderCNworks/pokemmo-report.tar.gz HEAD
scp /g/QoderCNworks/pokemmo-report.tar.gz root@159.198.67.190:/root/

# 在服务器上：解包覆盖 → 重建镜像 → 换容器（数据在 /opt/pokemmo/data，不会被动）
tar xzf /root/pokemmo-report.tar.gz -C /opt/pokemmo-report
cd /opt/pokemmo-report && docker build -t pokemmo-report:1.1 .
docker stop pokemmo-report && docker rm pokemmo-report
docker run -d --name pokemmo-report --restart unless-stopped -p 3580:3580 \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD=123456 -e TZ=Asia/Shanghai \
  -v /opt/pokemmo/data:/app/data --memory 256m pokemmo-report:1.1
docker image prune -f          # 清掉旧镜像
```

机器人地址存在 `/opt/pokemmo/data/config.json` 里，跟着 `-v` 落地，换镜像不用重填。
备份就这一条（`db.json` 是点位与上报，`config.json` 是机器人地址和订阅规则）：

```bash
cd /opt/pokemmo/data && tar czf poke-backup.$(date +%F).tar.gz db.json config.json
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

更新命令按**你服务器上是怎么跑起来的**分路。先跑 4.0 判断，再照 4.1 / 4.2 / 4.3 里对应的那条执行。

#### 4.0 先判断：端口是谁占着

只读、不改任何东西，输出很短，整段贴回来就能判断：

```bash
ss -lntp | grep ':3580 '; docker ps -a --format '{{.Names}} | {{.Status}} | {{.Ports}}'
```

- 出现 `docker-proxy`，且 `docker ps` 里有 `pokemmo-report | Up ... | 0.0.0.0:3580->3580/tcp`
  → **Docker 部署，走 4.1**。这时千万别用 systemd 抢端口（会撞 `EADDRINUSE` / `errno -98`）。
- 没有 docker，且 `systemctl status poke` 是 active → **systemd 部署**：本机 `ssh` 得通走 4.2，
  报 `ssh: connect to host ... port 22: Connection timed out` 走 4.3。

#### 4.1 Docker 部署：一条命令升级（推荐，实测在用）

在云控制台的网页终端（或任何已经登上服务器的 shell）里，**整段粘贴**：

```bash
curl -fsSL --max-time 30 -o /root/sdu.sh "https://gh-proxy.com/https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-docker-upgrade.sh" \
  || curl -fsSL --max-time 30 -o /root/sdu.sh "https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-docker-upgrade.sh"
grep -q 'MOUNT_OVERRIDE' /root/sdu.sh && bash /root/sdu.sh --mount=/opt/pokemmo/data:/app/data
```

三行各自为什么这么写：

1. 先试 `gh-proxy.com`，代理挂了自动回落官方 `raw`（`raw` 在国内多数网络不通，所以留两条）。
2. `grep -q 'MOUNT_OVERRIDE'` 是**内容守卫**：拿到的脚本必须真含新版才执行。GitHub 对分支压缩包有缓存，
   没有这道守卫可能跑了一份旧脚本再报错。**如果这条什么都没打印就返回了，是守卫没放行**
   （脚本还是旧的），重跑上一行 `curl` 即可。
3. `--mount=/opt/pokemmo/data:/app/data` 显式给挂载、**不去读旧容器的挂载表**。实测过：有机器
   `docker inspect` 出来的挂载表里混着空项，`docker run` 会报 `invalid empty volume spec` 并触发回滚。
   数据目录不是这个路径的话，换成 `docker inspect` 里那个 `Source`；`--mount=` 可以给多次。

脚本行为：取代码 → 先 `docker build` → 旧容器**只改名不删** → 新容器轮询到 HTTP 200 才删旧容器，
起不来自动把旧容器恢复回去；旧镜像留成 `pokemmo-report:rollback`。
`/opt/pokemmo/data` 里的 `db.json`（点位与上报）和 `config.json`（机器人连接、订阅规则）都不会被动。

**如果管理台改过密码却不生效**：早期起容器时 `-e` 过密码，之后每次升级都继承下来，
环境变量会盖过网页里设置的密码。归正回 `admin` / `123456`：

```bash
bash /root/sdu.sh --mount=/opt/pokemmo/data:/app/data --reset-admin
```

#### 4.2 systemd 部署，本机 ssh 得通：一条命令更新

在你自己电脑上、仓库目录里跑（Git Bash）：

```bash
bash tools/deploy-update.sh                  # 默认 root@159.198.67.190，端口 3580
bash tools/deploy-update.sh root@别的IP 3581 # 换主机或端口
```

它做五件事：把**已提交的 HEAD** 打包 → 通过 ssh 传到服务器 → 识别你是 systemd 还是 docker 部署 →
解包覆盖代码并重启 → 在服务器本机 `curl` 一次、再从你电脑外网 `curl` 一次。
要点：

- 只打包已提交的 HEAD。工作区有未提交改动时它会先提示你，那些改动不会上服务器。
- 服务器不需要 git，也不需要能访问 GitHub（第 0 节那个坑不会再踩一次）。
- **`data/` 不在包里**，`db.json`（点位与上报）和 `config.json`（机器人连接、订阅规则）都不会被覆盖。
- 认不出任何已部署痕迹时会**直接退出并告诉你这是首次部署**，不会半路创建服务。
- Docker 部署不用这条：`deploy-update.sh` 只会更新代码并打印 4.1 的命令，删容器换镜像属于不可逆动作，它不替你做。Docker 直接跑 4.1。

#### 4.3 systemd 部署但本机连不通 22 端口：让服务器自己取代码

`deploy-update.sh` 要在能 `ssh` 通服务器的电脑上跑。如果 22 端口被云防火墙挡着（实测过：`ssh: connect to host ... port 22: Connection timed out`，而 80/443 是通的），
就在**云控制台的网页终端**里跑下面这段，让服务器自己去 GitHub 取代码。

服务器上已经有 `/opt/pokemmo-report` 的话，直接从第二条开始：

```bash
# 1) 连 /opt/pokemmo-report 都没有：先把更新脚本本身取下来（内容守卫：必须含 PKG_VER 才执行）
curl -fsSL --max-time 30 -o /root/su.sh "https://gh-proxy.com/https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-update.sh" \
  || curl -fsSL --max-time 30 -o /root/su.sh "https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-update.sh"
grep -q 'PKG_VER' /root/su.sh && bash /root/su.sh --check

# 2) 代码目录已在服务器上：先只探测（不改任何东西），确认能取到包、包里是哪个提交
bash /opt/pokemmo-report/tools/server-update.sh --check
# 3) 探测通过就真的更新（备份 → 解包 → 重启 → 自检）
bash /opt/pokemmo-report/tools/server-update.sh
```

它按 `codeload.github.com → gh-proxy.com → ghproxy.net` 顺序试，取到后先验包（gzip 合法、条目 >400、
必须有 `server.js`、数一下图鉴图），验不过就直接放弃不动现有代码；更新前把整个代码目录备份成
`.prev`，回滚就是把 `.prev` 覆盖回去。`data/` 不在仓库包里，所以点位、上报记录、机器人连接和订阅规则都不会被动。
它是按 `poke.service` 存在与否判定部署方式的：**Docker 部署请直接用 4.1**，走这条只会更新代码并打印重建镜像的命令，不替你换容器。

想让本机脚本能用，就得在云控制台把 TCP 22 放行（更安全的做法是只放行你自己当前的出口 IP）。

#### 4.4 手动更新（systemd 那条路，脚本也不好用时的兜底）

前两条命令要在**本机的 Git Bash** 里跑（`/g/...` 是 Git Bash 写法，PowerShell 里 `scp` 会报
`No such file or directory`，这就是踩过的那次）：

```bash
# 本机 Git Bash（仓库目录里）
git archive --format=tar.gz -o /g/QoderCNworks/pokemmo-report.tar.gz HEAD
scp /g/QoderCNworks/pokemmo-report.tar.gz root@159.198.67.190:/root/

# 服务器
tar xzf /root/pokemmo-report.tar.gz -C /opt/pokemmo-report
systemctl restart poke && journalctl -u poke -n 10 --no-pager
```

#### 4.5 回滚

systemd 部署：服务跑的是 `/opt/pokemmo-report` 里的代码，回滚就是把旧代码盖回去
（`server-update.sh` 会自动留 `.prev`，`deploy-update.sh` 不会，要留自己执行下面第一条）。

```bash
cp -a /opt/pokemmo-report /opt/pokemmo-report.prev                      # 更新前自己留一份
cp -a /opt/pokemmo-report.prev/. /opt/pokemmo-report/ && systemctl restart poke   # 出问题回退
```

Docker 部署：4.1 那条脚本已经把旧镜像留成标签了，回滚不用重新构建——

```bash
docker stop pokemmo-report && docker rm pokemmo-report
docker run -d --name pokemmo-report --restart unless-stopped -p 3580:3580 \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD=123456 -v /opt/pokemmo/data:/app/data \
  pokemmo-report:rollback
```

它自己会打印同样的一条命令（含你实际的挂载），照抄即可。新容器起失败时脚本会当场把旧容器改名恢复回去，
不会留下"端口没人听"的状态。

上游静态参考表在 `data/upstream/`，12 小时自动刷一次。备份打包那两个数据文件即可（命令见第 2b 节末尾）。

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

**首次部署想省事就一条命令**——`tools/server-bootstrap.sh` 把下面 1~6 步全包了（取代码 → 缺 Node 就从 npmmirror 装 →
建 `poke.service` → 启动 → 本机自检），幂等可重复跑，不动 `data/`。在云控制台网页终端里整段粘贴：

```bash
curl -fsSL --max-time 30 -o /root/sb.sh "https://gh-proxy.com/https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-bootstrap.sh" \
  || curl -fsSL --max-time 30 -o /root/sb.sh "https://raw.githubusercontent.com/dll315/pokemmo-report/main/tools/server-bootstrap.sh"
grep -q 'systemd/system/poke.service' /root/sb.sh && bash /root/sb.sh
```

下面 1~6 步是它做的事情的展开，想手动控制每一步（或者服务器出网受限、只能从第 0 节 scp 包上来）就照着手敲。

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

# 4) systemd 单元：账号 admin、密码 123456，机器人不写在这里
cat > /etc/systemd/system/poke.service <<EOF
[Unit]
Description=PokeMMO 报点站
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/pokemmo-report
Environment=HOST=0.0.0.0
Environment=ADMIN_USER=admin
Environment=ADMIN_PASSWORD=123456
Environment=TZ=Asia/Shanghai
ExecStart=${NODE_BIN} server.js 3580
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now poke
```

**unit 里不放 `WECOM_WEBHOOK`**：设了它，管理台的连接列表里就会多出一条**锁定的**记录（改不动也删不掉，要取消得先删掉这行再 `systemctl restart poke`）。服务起来后直接在 `http://159.198.67.190:3580/admin` 添加机器人地址，保存即生效（写进 `data/config.json`，重启不丢）。

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
*/5 * * * * cd /opt/pokemmo-report && STATE_DIR=data node tools/actions-sync.js && node tools/publish-pages.js --skip-build >> /var/log/poke-pages.log 2>&1
EOF
crontab /tmp/ct && rm -f /tmp/ct
```

   这条 cron **不写机器人地址**：`actions-sync.js` 先读 `data/config.json`（就是管理台「企业微信机器人」写的那份），
   环境变量只在显式给了的时候覆盖。所以机器人统一在管理台配，cron 和服务用的是同一条地址、同一份订阅规则。
   `STATE_DIR=data` 是让跑批和自建服务共用同一份库（不给的话跑批会写到 `state/`，Pages 那条读的是 `data/`，两边对不上）。
   临时想只更新网页不推送：把 cron 那行加上 `PUSH_ENABLED=0`（比去改配置里的总开关更安全）。
4. **验证**：浏览器开 Pages 地址，看板应有点位；`curl -s <地址>/data.json | head -c 200` 能看到
   `generatedAt` 在刷新；每次跑完 `git fetch && git log --oneline origin/pages -1` 应有新提交。
5. **不要和 A 段同时开推送**（两处都会往同一个群发，会重复）。要"服务器推送 + Pages 只做展示"，
   就给 cron 那条加 `PUSH_ENABLED=0`，管理台里的开关不用动。

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
- **点「测试推送」报"发送失败"时先看括号里的中文原因**（管理台与 `journalctl` 都会给）：
  `93000` = 机器人 key 不对或已被移出群；`45009` = 你点太快被限流，等一分钟再点就好（不是配置错）；
  `40058/40008` = 消息内容或类型问题（本程序只发 markdown，出现这两条算 bug，把日志发我）；
  `连不上机器人地址` = 服务器出网/DNS/防火墙问题，用 `curl -s -o /dev/null -w "%{http_code}\n" https://qyapi.weixin.qq.com/cgi-bin/get_api_domain_ip` 单独验。
  测试成功但真实报点不推，通常是「推送总开关」没打开——测试接口不受开关约束，就是为了让你能单独验通路。
- markdown 消息上限 **4096 字节**，代码里已做截断。
- 支持的颜色只有 `info / comment / warning`，别的会退成默认色。
- 发送失败不推进队列，重试 5 次后丢弃并记日志；点位过期也会静默丢弃（不再打扰）。
- 机器人地址**只在管理台「企业微信机器人」这一块管**，而且可以是**多条**：一条点位会送达到每条启用的连接，每条能单独改名 / 启用停用 / 删除 / 点「测试」验证。列表里只显示域名+路径+key 尾 6 位（完整 key 不回浏览器），并记录每条最后一次发送的成功与失败原因；不合法的地址（少 `key=`、带空格换行、不是 http(s)）会被当场拒绝且不落盘。
- 想只推某个群：把其它连接停用或删掉即可。企业微信的 20 条/分钟限速是**按每个机器人**算的，多群之间不互相占用；但每轮每个机器人都最多发 `maxPerTick` 条。
- 环境变量 `WECOM_WEBHOOK` 如果设了，它会作为**一条锁定连接**出现在列表最前面（改不动也删不掉，要取消就在容器/systemd 里删掉那行再重启），不影响你另外添加的连接。
- 换群就是加一条新连接、测通后删掉旧的；建议先建个测试群跑几天。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 看板一直空 | 那个时段确实没人报点（上游 Alpha 报点每天集中在 4 个时段）。用 `tools/demo-events.js` 造数据验证界面。 |
| `会话就绪` 之后 totalRows=0 | 上游令牌与会话 cookie 绑定，代码已自动重建会话重试；持续失败说明上游改了页面结构，检查 `src/upstream.js` 里 `history-api-token` 的正则。 |
| 日志出现 `429 / HTTP 5xx` | 抓得太急。把同步间隔调到 5 分钟以上。 |
| 中文名显示成英文 | `data/cn-species.json` / `cn-locations.json` 没进容器（`.dockerignore` 别把它们排除），或管理台点「重载词表」。 |
| 小图标不显示、只剩首字圆徽 | `public/assets/sprites/` 没被打进去（483 张共 0.36MB，正常随仓库走）。补一次：`npm run sprites`，它按 `data/sprite-manifest.json` 里的 git blob SHA 逐张校验后才落盘。 |
| 推送 errcode 93000 | webhook key 不对（机器人被移出群或复制错）。管理台现在会把错误码翻成中文原因，见上面「企业微信侧注意」。 |
| 上报提交后看不到 | 默认要管理员在 `/admin` 放行；想直发就关掉「上报需人工审核」。 |
| 想重灌历史 | 停服务后 `node tools/reseed.js 168 --force`（容器里 `docker compose exec report node tools/reseed.js 168 --force`，注意先 `-e` 停调度）。 |
| Actions 跑批报 `HTTP 403`、库存 0 | 上游 Cloudflare 拦数据中心 IP，不是代码问题。改走 DEPLOY.md 的 B2（你的机器跑批 + Pages 分支托管），用 `node tools/probe-upstream.js` 确认。 |
| build 报 `unable to prepare context: path "/opt/pokemmo-report" not found` | 那个目录根本不存在／是空的——clone 没成功就往下的命令全跑了一遍。`ls /opt/pokemmo-report/Dockerfile` 确认代码到位，取不到代码看第 0 节。 |
| `Get "https://registry-1.docker.io/v2/": context deadline exceeded` | Docker Hub 在境内连不上，跟本站代码无关。第 0b 节配加速源，或者干脆走第 6 节纯 Node（零依赖，不需要任何镜像）。 |
| `FirewallD is not running` | 系统层防火墙本来就没开，`firewall-cmd` 那两条不用管；端口只剩云控制台「防火墙/安全组」一道，见第 3 节。 |
| **更新后管理台没有任何变化** | 十有八九是**跑的还是旧镜像**：`docker restart`／`systemctl restart` 都不会重建镜像。先 `curl -s http://127.0.0.1:3580/api/config/public \| grep -o '"build":{[^}]*}'` 看运行版本，和 `cat /opt/pokemmo-report/BUILDINFO` 的包内版本比；不一致就按第 4.1 节重建（Docker）或 `systemctl restart poke`（systemd）。管理台右上角的版本号是同一个值。 |
| `listen ... port 3580 errno: -98`（EADDRINUSE） | 端口已被占着。`ss -lntp \| grep ':3580 '` 看占的进程：`docker-proxy` 说明容器在跑（改用第 4.1 节，别再起 systemd），`node server.js` 且 cwd 是本项目就是手动起的游离进程，`kill` 掉它。 |
| `docker: invalid empty volume spec` 并触发回滚 | 旧容器的挂载表里混着空项，`docker inspect` 抄出来的 `-v` 有空的。用第 4.1 节的 `--mount=/opt/pokemmo/data:/app/data` 显式指定挂载，不去读旧容器的表。 |
| 管理台改了密码，下次登录还是旧密码 | `ADMIN_PASSWORD` 环境变量优先于 `config.json`（容器是 `-e` 起的，升级时又被继承了一遍）。要么在容器里改掉那行，要么直接 `bash /root/sdu.sh --mount=... --reset-admin` 归正回 `admin` / `123456`。 |
| 外网 `HTTP 000`／浏览器打不开，而服务器本机 `127.0.0.1:3580` 是 200 | 云控制台的防火墙/安全组没放行 TCP 3580（本机服务是好的，别查代码）。见第 3 节。 |
| 界面或卡片里出现英文 | 两种情况：① **跑的是旧版本**——早期版本故意写成「冲浪（Surf）」这种双语，玩家反馈满屏英文，已改成只出中文、英文进鼠标悬停，比一下 `build.version` 就知道；② **那个词确实没有可核译名**——上游语言包和 PokeAPI 都没有的专名（如阿斯卡纳遗迹的 `Rixy` 石室）按口径保留原文，不自己造词（见 README 的术语来源一节）。`npm test` 里有一组"可见文本一律中文"的对账，会把双语形态直接判失败。 |
| `bash: /opt/pokemmo-report/tools/server-docker-upgrade.sh: No such file or directory` | 代码根本没到那个目录（clone/解包失败却继续往下跑）。`ls /opt/pokemmo-report/Dockerfile` 确认，取不到代码看第 0 节；本机 `scp` 那类路径要在 **Git Bash** 里写，PowerShell 不认 `/g/...`。 |
