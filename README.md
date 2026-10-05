# PokeMMO 报点站（中文镜像 + 玩家上报 + 企业微信推送）

面向国内 PokeMMO 玩家的 Alpha / 群蜂 / 特异天气报点看板。数据主要镜像自
[Alphapedia](https://alpha.pokemmotools.org/)，界面全中文，另有本站玩家上报入口和审核队列，
新点位可自动推送到企业微信群。单进程、零 npm 依赖，一个容器就能跑。

## 功能

- **实时看板**：三列（头目 Alpha / 大量出现 Swarm / 奇遇 Pheno），带剩余时间倒计时，每 30 秒自动刷新
- **点位需求**：每条报点直接显示"去之前要什么秘传兽"、具体位置说明、上游备注（含反伤招式警告）与点位地图截图链接
- **Alpha 刷新时段**：按 UTC 0/6/12/18 点起、每段 4 小时 45 分现算，同时给北京时间
- **中文对照**：宝可梦名、地区名、地点名、招式名、特性名、属性名、天气类型全部中文为主、英文括注
- **图鉴图标**：483 张第五世代 96×96 图随仓库发布（0.36MB），不热链 GitHub，缺图自动降级为中文名首字徽标
- **玩家上报**：下拉选择宝可梦与地点（不接受自由文本编新地点），提交后进待审核队列
- **管理台** `/admin`：审核队列、推送订阅规则、同步日志、手动触发同步、测试推送
- **企业微信推送**：机器人 markdown 卡片，支持按类型 / 地区 / tier / 关注名单 / 屏蔽名单 / 免打扰时段过滤
- **图鉴参考**：某地点能刷什么 Alpha / 群蜂 / 特异天气、需要什么秘传器、价值 tier
- **两条部署路径**：自建服务器（Docker 单容器）或 GitHub Pages + Actions 静态快照

## 快速开始（本地）

```bash
# 需要 Node 16+
cp config.example.json data/config.json   # 管理账号、密码、webhook 都填这里
node server.js 3580 --host=127.0.0.1    # 首次启动会自动回填上游报点
# 浏览器打开 http://127.0.0.1:3580/ ；管理台 http://127.0.0.1:3580/admin
```

没有真实报点时可以先造几条演示数据看界面：

```bash
ADMIN_USER=admin ADMIN_PASSWORD=你的密码 node tools/demo-events.js --url=http://127.0.0.1:3580
```

验证推送排版时，建议先用本地假端点，别直接往自己群里发：

```bash
node tools/mock-webhook.js 3599 &
WECOM_WEBHOOK="http://127.0.0.1:3599/send?key=MOCK" node server.js 3580
```

## 自检

```bash
npm test                                   # 纯逻辑单测 22 组，不联网
ADMIN_USER=admin ADMIN_PASSWORD=密码 npm run selftest   # 对着跑着的服务打 60 项接口用例
node tools/verify-cn-data.js               # 校验宝可梦名/地点名覆盖率
npm run verify:terms                       # 校验术语表覆盖率
npm run phrases                            # 重新生成整句表（上游语言包有更新时）
npm run terms                              # 重新生成招式/特性/属性/HM 术语表
npm run audit:eggs                         # 蛋组映射取证（成员集合包含率）
npm run audit:sources                      # 译名溯源复核：整句表回指语言包，术语表回打 PokeAPI
```

`audit:sources` 是**不信任生成过程**的那一道：它把 252 条整句译文逐条回指到上游语言包或蛋组取证结果，
再抽样重新请求 PokeAPI 比对官方 `zh-hans`（当前 172 条抽样 0 处不符）。

`selftest` 会提交并驳回一条测试上报、（配了 webhook 时）发一条测试推送，其余都是只读。

## 部署

三条路，参数含义、更新、备份、放行端口、故障排查都在 **DEPLOY.md**。

### A. 服务器上直接 `docker run`（推荐）

```bash
# 1) 登上服务器
ssh root@159.198.67.190

# 2) 取代码（仓库已公开，HTTPS 免密 clone 即可）
git clone https://github.com/dll315/pokemmo-report.git /opt/pokemmo-report
cd /opt/pokemmo-report

# 守卫：看不到 Dockerfile 就是代码没下来（clone 失败时目录是空的，
# 或在自己电脑上 git archive + scp 传包，见 DEPLOY.md 第 0 节），别再往下 build
test -f Dockerfile && echo "代码到位 ✓" || echo "没拿到代码，停在这里"

# 3) 数据目录 + 镜像
mkdir -p /opt/pokemmo/data
docker build -t pokemmo-report:1.0 .
```

> ⚠️ **境内服务器大概率在这一步被卡住**：`FROM node:20-alpine` 要拉 Docker Hub，
> 而它在国内是连不上的（`Get "https://registry-1.docker.io/v2/": context deadline exceeded`）。
> 两条解法，按顺序试（细节在 DEPLOY.md 第 0b 节）：
> ① 给 Docker 配腾讯云内网加速源 `mirror.ccs.tencentyun.com`；
> ② **绕过 Docker**，用下面的 B 段纯 Node + systemd——本站零 npm 依赖，跑起来效果完全一样。

```bash
# 4) 起容器
docker run -d --name pokemmo-report --restart unless-stopped \
  -p 3580:3580 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD='换成你自己的密码' \
  -e WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人key" \
  -e TZ=Asia/Shanghai \
  -v /opt/pokemmo/data:/app/data \
  --memory 256m pokemmo-report:1.0

# 5) 本机防火墙放行；如果打印 FirewallD is not running 就说明系统层没开防火墙，跳过即可
firewall-cmd --permanent --add-port=3580/tcp && firewall-cmd --reload

docker logs -f pokemmo-report        # 首启回填 48 小时报点，约 15~25 秒
```

打开这两个地址：

| | |
|---|---|
| 看板 | `http://159.198.67.190:3580/` |
| 管理台 | `http://159.198.67.190:3580/admin` → 账号密码就是你上面 `-e` 里设的那两个 |

还要在**云厂商控制台的安全组**放行 TCP 3580，只开本机防火墙不够。

- 程序默认账号 `admin`、默认密码 `123456`（启动日志与管理台都会标"弱口令"）。**公网部署必须改掉**：登录后「站点设置 → 修改密码」，或部署时用 `-e ADMIN_PASSWORD=` 覆盖。仓库是公开的话，别把真实密码写进任何提交或文档。
- 不带 `WECOM_WEBHOOK` 就只更新网页不推送；填了就以它为准，网页里改 webhook 不会生效。
- `-v` 一定要给：玩家上报、审核记录、同步游标都在 `/opt/pokemmo/data/db.json`，备份也就拷这一个文件。
- 有 compose 更省事：`cp .env.example .env`（填三个值）→ `docker compose up -d --build`。

### B. 不装 Docker：纯 Node + systemd

Docker Hub 拉不动、或者不想多一层镜像时走这条。本站零依赖，**没有 `npm install` 这一步**。

```bash
# 注意 .env 只有 docker compose / --env-file 会读，裸 node 不认（零依赖=没装 dotenv）
cd /opt/pokemmo-report
HOST=0.0.0.0 ADMIN_USER=admin ADMIN_PASSWORD='换成你自己的密码' node server.js 3580

# 先这样手动跑通（首启回填十几秒），确认 http://服务器IP:3580/ 有点位，
# 再按 DEPLOY.md 第 6 节写成 systemd 服务常驻（含 Node 版本不够时从 npmmirror 取二进制的方法）
```

### C. GitHub Pages 托管（静态快照，无上报/审核）

⚠️ **上游 Cloudflare 会拒绝 GitHub Actions 的出口 IP（全站 403），所以不能让 Actions 定时抓数据**——
实测过一次"全绿但库存 0、部署出空站"。可行做法是把抓取放在能连上上游的机器上（服务器/本机 cron），
Pages 只做分支托管：

```bash
node tools/publish-pages.js        # 生成 dist 并推到 pages 分支
# 服务器上 cron 每 5 分钟：抓数据+推送，再发布快照
*/5 * * * * cd /opt/pokemmo-report && STATE_DIR=data node tools/actions-sync.js && node tools/publish-pages.js >> /var/log/poke-pages.log 2>&1
```

Pages 设置成 `Deploy from a branch` → 分支 `pages`、目录 `/ (root)`。
若哪天上游放行 Actions 的 IP，给仓库加 Variable `PAGES_VIA_ACTIONS=1` 即可切回全自动。

## 数据说明与已知边界

| 事项 | 说明 |
|---|---|
| 数据来源 | 上游 Alphapedia 是**玩家众包**数据，不是官方接口；点位可能误报或过期。页面底部保留署名与跳转。 |
| 报点时效 | 上游历史接口的时间戳是**报出时刻**（用 `Relicanth` 那条与首页倒计时对账验证过）。有效期按上游前端常量：Alpha 75 分钟、群蜂最多 25 分钟，可在管理台改。 |
| 特异天气流水 | 上游**没有** pheno 的历史接口，`/api/history-data` 只覆盖 Alpha 与群蜂。本站的特异天气列只显示玩家上报的点。 |
| 上游异常 | 上游偶发把宝可梦名返回成图鉴号（实测出现过 `pokemon: "369"`），已用反查表还原；令牌与会话 cookie 绑定，失效时会自动重建会话重试。 |
| 术语来源 | 宝可梦名 / 招式名 / 特性名 / 属性名取自 **PokeAPI 的 `zh-hans` 官方简中**；`头目=Alpha`、`大量出现=Swarm`、`群怪=Horde`、`奇遇=Pheno` 与 `卷尘 / 动草 / 影子 / 水面` 四种天气取自 **Alphapedia 自带的简体中文语言包** `extra-zh.json`（社区通用叫法），不自己造词，认不出的一律回落英文。注意官方简中里 **HM「Strength」与宝可梦怪力（Machamp）同名**，界面写成 `怪力（Strength）` 带英文括注，不是翻错。 |
| 整句汉化 | `data/cn-phrases.json`（252 条）把上游的**备注与位置说明整句**翻成中文，每条都能回指到 Alphapedia 简体中文语言包，例如 `Acro Bike required` → 需要越野自行车、`⚠ ADS HAVE RECOIL ⚠` → 小怪带反伤自残技能、`South` → 南侧。 |
| 蛋组名取证 | 上游用 PokeMMO 黑话（`Water A/B/C`、`Chaos`、`Cannot Breed`、`Genderless`），语言包和 PokeAPI 招式表都没有。`npm run audit:eggs` 按**宝可梦成员集合的包含率**推出每个黑话对应哪个官方蛋组，再直接取该蛋组的 PokeAPI `zh-hans` 名（19/19 包含率 ≥0.925，证据落在 `data/egg-group-mapping.json`）。这一步纠正了手写表里的错译：**`Field` 官方作「陆上」，不是「场地」**；`Chaos` → 不定形、`Cannot Breed` → 未发现、`Genderless` → 矿物。 |
| 译名分歧 | `Giant Chasm` 官方维基作「巨人洞窟」，PokeMMO 圈也常说「巨大之洼」；`Tanoby Ruins` 作「阿斯卡纳遗迹 / 蔓藤废墟」。想改就写 `data/cn-overrides.json`：`{"locations":{"Giant Chasm":"巨大之洼"}}`，管理台点「重载词表」即可生效。 |
| 图鉴图 | **483 张第五世代 96×96 图已随仓库发布**（`public/assets/sprites/`，共 0.36MB），前端不热链 `raw.githubusercontent.com`（境内打不开）。取图走公共 GitHub 代理但**不信任代理**：文件清单与 git blob SHA-1 来自 `api.github.com` 的 git trees 接口，每张落盘前重算 `sha1("blob "+长度+"\0"+内容)` 比对，取证写在 `data/sprite-manifest.json`，`npm test` 会逐张复核。动图（`--with-animated`）要多 17MB，明文端口直发不划算，默认不带；缺图自动降级为中文名首字徽标。 |
| 抓取礼貌 | 增量同步默认 2 分钟一次，每页之间 sleep 700ms，静态参考表 12 小时才刷一次。上游 `robots.txt` 只有内容信号模板、没有 Disallow；转载请保留数据来源署名。 |

## 接口一览（本站）

公开：`GET /api/board`、`GET /api/events`、`GET /api/ref/options`、`GET /api/ref/species?name=`、
`GET /api/ref/location?name=`、`POST /api/report`
管理：先 `POST /api/admin/login`（账号 + 密码）换 HttpOnly 会话 cookie，之后
`GET /api/admin/state|config|export`、`PUT /api/admin/config`、
`POST /api/admin/sync|approve|reject|test-push|flush|reload-dict`；无会话一律 401，登录限频 8 次/10 分钟

## 目录结构

```
server.js            HTTP 服务 + 静态站点 + 同步/推送调度
src/                 net(零依赖 HTTP) / upstream(抓取) / store(JSON 持久层)
                     sync / normalize / dict(译名) / refdata(静态表) / rules / push-wecom
                     slots(时段) / board(看板组装) / config / local(上报与审核)
public/              玩家端与 admin 端
tools/               build-cn-data 译名生成 · verify-cn-data 校验 · mirror-sprites 图鉴图镜像
                     reseed 重灌历史 · build-static + actions-sync Pages 路径 · mock-webhook 测试
data/                cn-species.json / cn-locations.json / upstream/*.json / db.json(运行期)
state/               Pages 路径的游标状态（需提交回仓库）
```
