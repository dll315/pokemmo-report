# 部署说明

两条路径，按你手上有什么机器选：

| | A. 自建服务器（推荐） | B. GitHub Pages + Actions |
|---|---|---|
| 看板实时性 | 默认 2 分钟同步一次 | 受 Actions cron 限制，最小 5 分钟，高峰期会延迟 10–20 分钟 |
| 玩家上报 / 审核 | ✅ | ❌（静态快照没有后端，入口自动隐藏） |
| 企业微信推送 | ✅ 服务端定时发 | ✅ 由 Actions 跑批时发 |
| 需要 | 一台国内服务器 + 开一个端口 | 只用 GitHub |
| 数据落地 | 宿主机 `./data/db.json` | 仓库里的 `state/db.json` |

---

## A. 自建服务器（Docker 单容器）

### 1. 准备

```bash
# 服务器上，装好 Docker 之后
git clone <你的仓库地址> pokemmo-report
cd pokemmo-report

# 管理口令自己生成一个长随机串，别用默认值
openssl rand -hex 16
cat > .env <<'EOF'
ADMIN_TOKEN=把上面生成的串填进来
WECOM_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人key
EOF
```

`WECOM_WEBHOOK` 可以先留空，之后在管理台网页里填也行；**一旦用环境变量注入，环境变量优先，网页里改 webhook 不会生效**（启动日志会提醒）。

### 2. 起服务

```bash
docker compose up -d --build
docker compose logs -f      # 首次启动会回填 48 小时报点，看到"同步 每 2 分钟一次"就算好了
```

访问 `http://服务器IP:3580/`，管理台 `http://服务器IP:3580/admin`（粘 `ADMIN_TOKEN`）。

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
  -e ADMIN_TOKEN='你的长随机口令' \
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
| `-e ADMIN_TOKEN` | 管理台与 `/api/admin/*` 的口令 | **所有管理接口直接 403 不可用**（安全默认，不是坏了） |
| `-e WECOM_WEBHOOK` | 企业微信机器人地址 | 只更新看板，不推送；也可以在管理台网页里填 |
| `-e TZ` | 容器时区 | 不影响业务时间（代码按 UTC+8 硬算北京时间），只影响日志可读性 |
| `-v /opt/pokemmo/data:/app/data` | 数据落地 | 容器一删，玩家上报和同步游标全没 |
| `--restart unless-stopped` | 开机/崩溃自启 | 服务器重启后服务不会自己起来 |
| `--memory 256m` | 上限保护 | 一般用不到（常驻内存约 60MB），留着防意外 |

日常操作：

```bash
docker logs -f pokemmo-report                # 看同步与推送日志（第一次要等 15~25 秒回填）
docker inspect -f '{{.State.Health.Status}}' pokemmo-report   # healthcheck: healthy / unhealthy
docker exec -it pokemmo-report node tools/selftest.js --url=http://127.0.0.1:3580   # 自检 49 项
docker stop pokemmo-report && docker rm pokemmo-report        # 停止并删除（数据在宿主机，不会丢）
```

更新到新版本：

```bash
git pull
docker build -t pokemmo-report:1.1 .
docker stop pokemmo-report && docker rm pokemmo-report
docker run -d --name pokemmo-report --restart unless-stopped -p 3580:3580 \
  -e ADMIN_TOKEN='同样的口令' -e WECOM_WEBHOOK='同样的地址' -e TZ=Asia/Shanghai \
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

### 6. 不用 Docker 的备选：纯 Node + systemd

```bash
yum install -y nodejs || apt install -y nodejs        # 需要 Node 16+
useradd -r -s /sbin/nologin poke
cp config.example.json config.json && vim config.json  # 填 adminToken 与 webhook
mkdir -p /etc/systemd/system && cat > /etc/systemd/system/poke.service <<'EOF'
[Unit]
Description=PokeMMO 报点站
After=network.target

[Service]
WorkingDirectory=/opt/pokemmo-report
Environment=HOST=0.0.0.0
Environment=ADMIN_TOKEN=你的口令
Environment=WECOM_WEBHOOK=你的机器人地址
ExecStart=/usr/bin/node server.js 3580
Restart=always
User=poke

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now poke && journalctl -u poke -f
```

---

## B. GitHub Pages + Actions（无服务器降级）

### 能，但定位是"降级用"，不是省事实

Pages 路径 = GitHub Actions 每 10 分钟抓一次上游 → 生成静态 `dist/` 部署到 Pages → 顺带把新点位发到企业微信群。**不用买服务器、不用备案**，代价是三条：

| | 自建 Docker | Pages + Actions |
|---|---|---|
| 新点位延迟 | 默认 2 分钟 | cron 最小 5 分钟，且 Actions 排队常拖到 10~20 分钟 |
| 玩家上报 / 审核 | ✅ | ❌ 静态页没有后端，入口会自动隐藏 |
| 看板倒计时 | 服务端时间 | 浏览器本地时间，两次跑批之间数字是陈的 |
| 图鉴图 | 可选本地镜像 | 不打包，显示中文名首字徽标 |

### 部署步骤

1. **推代码**：仓库建议 Public。私有仓库能不能用 Pages 取决于账户套餐，以第 2 步能否保存为准（不确定就先建 Public，之后随时可切 Private）。
2. **开 Pages，源选 Actions**：`Settings` → 左侧 `Pages` → `Build and deployment` → `Source` 选 **GitHub Actions**（不要选 Deploy from a branch）。这一步不做，后面的 `deploy-pages` 会直接失败。
3. **配密钥与变量**：`Settings` → `Secrets and variables` → `Actions`
   - `Secrets` 里加 **Repository secret** `WECOM_WEBHOOK` = 机器人地址（留空则只更新网页、不推送）
   - `Variables` 里按需加：`PUSH_KINDS`（默认 `alpha,swarm`）、`PUSH_ONLY`（只推这几只，逗号分隔，留空=全部）、`PUSH_EXCEPT`、`PUSH_REGIONS`（如 `Hoenn,Kanto`）、`PUSH_MIN_TIER`（低于该价值的点位不推）、`PUSH_MAX`（每轮最多发几条，默认 8）、`PUSH_ENABLED=0`（临时停推）、`BACKFILL_HOURS`（首轮回溯小时数，默认 48）
4. **手动跑第一次**：`Actions` → 左侧「同步快照并推送」→ `Run workflow`。这一次它会：登录上游取令牌 → 拉历史 → 写 `state/db.json` → **把这个游标文件提交回仓库** → 生成 `dist/` → 部署 Pages。
   - `state/db.json` 必须能提交回去，所以本工作流用了 `permissions: contents: write`；若你给仓库加了分支保护，要把 Actions 加进允许推送的名单，否则这一步会失败（站点仍能部署，只是每次都当首轮重灌、不会重复推送，因为队列状态没保存）。
5. **验证**：跑完在 workflow 页面看 `抓取上游并生成 dist` 这一步的日志，应有 `[sync] alpha: 取回 … 新增 …` 与 `dist 生成完成：活动点位 N`；然后打开 Pages 地址（`https://<用户名>.github.io/<仓库名>/`）。
6. **之后**：每 10 分钟自动跑；改代码 push 也会触发一次（只有改到 `src/ tools/ public/ workflow` 才触发，避免和回写 `state/db.json` 互相打转）。

### 本地先把这条路径验通（建议推上去之前做）

```bash
node tools/actions-sync.js                     # 读 state/db.json，抓上游，生成 dist/
WECOM_WEBHOOK=你的地址 node tools/actions-sync.js   # 顺便真的推一条，验证队列与卡片
node tools/build-static.js --data=data         # 只想用现有数据看效果时
python -m http.server -d dist 8123             # 浏览器开 http://127.0.0.1:8123
```

看到页面顶部提示"静态快照"、报点标签消失、看板有数据，就说明 Pages 这条路是通的。

### Pages 路径的已知坑

- **不要在同一个仓库同时跑 compose 和这个 workflow**，两边都会往群里推，会重复。二选一，或把 `PUSH_ENABLED` 设 `0` 只留网页。
- Actions 的 UTC 不影响推送逻辑（代码按 UTC+8 硬算北京时间），但 cron 表达式本身按 **UTC** 解释。
- 免费 Actions 分钟数有限（公有仓库不限量；私有每月 2000 分钟）。按 10 分钟一次跑满一个月约 4400 分钟用量，私有仓库要注意。
- Pages 在国内的可达性一般，访问慢或偶发连不上属正常，别当 SLA 用。


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
| 推送 errcode 93000 | webhook key 不对（机器人被移出群或复制错）。 |
| 上报提交后看不到 | 默认要管理员在 `/admin` 放行；想直发就关掉「上报需人工审核」。 |
| 想重灌历史 | 停服务后 `node tools/reseed.js 168 --force`（容器里 `docker compose exec report node tools/reseed.js 168 --force`，注意先 `-e` 停调度）。 |
