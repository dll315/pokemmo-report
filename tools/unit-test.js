#!/usr/bin/env node
"use strict";
/* 纯逻辑单元测试，不联网不起服务：时段边界、去重键、规则矩阵、时间戳解析、
   消息截断、队列语义、配置优先级、上报校验。
     node tools/unit-test.js   （退出码非 0 即有失败） */

const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.CONFIG_FILE = path.join(os.tmpdir(), "poke-unittest-" + process.pid + ".json");
delete process.env.WECOM_WEBHOOK;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASSWORD;

const ROOT = path.resolve(__dirname, "..");
const UPSTREAM_DIR = path.join(ROOT, "data", "upstream");
const { Store, eventKey } = require("../src/store");
const { slots } = require("../src/slots");
const rules = require("../src/rules");
const normalize = require("../src/normalize");
const push = require("../src/push-wecom");
const upstream = require("../src/upstream");
const local = require("../src/local");
const dict = require("../src/dict");
const conf = require("../src/config");

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name); console.log(`  FAIL ${name} —— ${e.message}`); }
}
const eq = (a, b, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};
const ok = (v, msg) => { if (!v) throw new Error(msg || "断言为假"); };
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Math.floor(Date.UTC(y, mo, d, h, mi, s) / 1000);
const ev = (over = {}) => ({
  key: "k", kind: "alpha", source: "upstream", pokemon: "Breloom", pokemonCn: "斗笠菇", region: "Hoenn",
  location: "Route 119", locationCn: "119号道路", tsUnix: 1791100000, expiresUnix: 1791100000 + 75 * 60, tier: 2, ...over,
});
const tmpStore = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poke-t-")); const s = new Store(dir); s.load(); return s; };

t("时段：4 段、每段 285 分钟、起点 UTC 0/6/12/18", () => {
  const s = slots(utc(2026, 9, 4, 7));
  eq(s.list.map((x) => x.start % 86400), [0, 21600, 43200, 64800]);
  ok(s.list.every((x) => x.end - x.start === 285 * 60), "段长");
  eq(s.current.index, 2);
  ok(!s.inGap);
});
t("时段：空档标记、下一段、到点即换段", () => {
  const gap = slots(utc(2026, 9, 4, 11));
  ok(gap.inGap && gap.current === null && gap.next.index === 3, "11:00 应在 10:45→12:00 空档");
  ok(slots(utc(2026, 9, 4, 10, 45)).inGap, "10:45:00 整点应已离开第 2 段");
  eq(slots(utc(2026, 9, 4, 6)).current.index, 2, "06:00:00 整点应已进入第 2 段");
});
t("北京时间换算与跨日", () => {
  eq(rules.fmtBeijing(utc(2026, 9, 4, 0)), "10-04 08:00");
  eq(rules.fmtBeijing(utc(2026, 9, 3, 20)), "10-04 04:00");
});
t("免打扰跨午夜", () => {
  const q = { enabled: true, from: "23:00", to: "07:00" };
  ok(rules.inQuietHours(utc(2026, 9, 4, 15, 30), q), "北京 23:30");
  ok(rules.inQuietHours(utc(2026, 9, 3, 22, 0), q), "北京 06:00 应静音");
  ok(!rules.inQuietHours(utc(2026, 9, 4, 0, 0), q), "北京 08:00 不该静音");
});

const base = () => ({ wecom: { webhook: "https://x/?key=y", enabled: true, kinds: ["alpha", "swarm"], onlyPokemon: [], exceptPokemon: [], regions: [], minTier: 0, maxPerTick: 4, quietHours: { enabled: false } } });
t("规则：类型/地区/关注/屏蔽/tier/过期/无 webhook 逐个拦住", () => {
  const now = 1791100100;
  const c = () => base();
  let x = c(); x.wecom.kinds = ["alpha"]; ok(!rules.decide(ev({ kind: "swarm" }), x, now).ok, "类型");
  x = c(); x.wecom.regions = ["Kanto"]; ok(!rules.decide(ev(), x, now).ok, "地区");
  x = c(); x.wecom.onlyPokemon = ["Gligar"]; ok(!rules.decide(ev(), x, now).ok, "关注未命中");
  x = c(); x.wecom.onlyPokemon = ["Breloom"]; ok(rules.decide(ev(), x, now).ok, "关注命中");
  x = c(); x.wecom.exceptPokemon = ["斗笠菇"]; ok(!rules.decide(ev(), x, now).ok, "中文屏蔽");
  x = c(); x.wecom.minTier = 3; ok(!rules.decide(ev({ tier: 2 }), x, now).ok, "tier");
  ok(!rules.decide(ev({ expiresUnix: now - 1 }), c(), now).ok, "过期");
  x = c(); x.wecom.webhook = ""; ok(!rules.decide(ev(), x, now).ok, "无 webhook");
});

t("eventKey：大小写无关、pheno 类型独立", () => {
  eq(eventKey({ kind: "alpha", pokemon: "Breloom", location: "Route 119", tsUnix: 5 }),
     eventKey({ kind: "alpha", pokemon: "breloom", location: "route 119", tsUnix: 5 }));
  ok(eventKey({ kind: "pheno", pokemon: "a", location: "b", tsUnix: 5, phenoType: "Grass" })
   !== eventKey({ kind: "pheno", pokemon: "a", location: "b", tsUnix: 5, phenoType: "Water" }));
});
t("Store：去重、按类型/来源/地区/关键词筛选、limit", () => {
  const s = tmpStore();
  const now = Math.floor(Date.now() / 1000);
  eq(s.putEvents([ev({ key: "A", pokemon: "Pikachu", location: "Route 1", tsUnix: now - 60, expiresUnix: now + 600 }),
                  ev({ key: "A", pokemon: "Pikachu", location: "Route 1", tsUnix: now - 60, expiresUnix: now + 600 })]), 1, "重复只算一条");
  s.putEvents([ev({ key: "B", kind: "swarm", region: "Kanto", location: "Route 2", pokemon: "Sneasel", tsUnix: now - 2 * 86400, expiresUnix: now - 2 * 86400 + 1500 })]);
  s.putEvents([ev({ key: "C", source: "local", pokemon: "Crobat", location: "Route 3", tsUnix: now - 100, expiresUnix: now + 900 })]);
  eq(s.events({ activeOnly: true }).rows.map((e) => e.key).sort(), ["A", "C"]);
  eq(s.events({ kind: "swarm" }).rows.map((e) => e.key), ["B"]);
  eq(s.events({ source: "local" }).rows.map((e) => e.key), ["C"]);
  eq(s.events({ region: "Kanto" }).rows.map((e) => e.key), ["B"]);
  eq(s.events({ q: "cro" }).rows.map((e) => e.key), ["C"], "搜索命中英文名");
  eq(s.events({ limit: 2 }).rows.length, 2);
  eq(s.events({ limit: 0 }).total, 3);
  ok(s.prune(1) >= 1, "过期要能裁掉");
});
t("Store：缺 expiresUnix 的老记录按 tsUnix 兜底判定", () => {
  const s = tmpStore();
  const now = Math.floor(Date.now() / 1000);
  s.putEvents([{ key: "L1", kind: "alpha", pokemon: "X", location: "Y", region: "Kanto", tsUnix: now + 60 },
               { key: "L2", kind: "alpha", pokemon: "Z", location: "W", region: "Kanto", tsUnix: now - 60 }]);
  eq(s.events({ activeOnly: true }).rows.map((e) => e.key), ["L1"], "没有窗口字段时只有 tsUnix 在未来才算活动");
});
t("Store：坏 db.json 不崩、留备份、能重写", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poke-bad-"));
  fs.writeFileSync(path.join(dir, "db.json"), "{这不是 JSON", "utf8");
  const s = new Store(dir);
  s.load();
  eq(s.index.size, 0);
  s.save();
  eq(JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8")).version, 1);
  ok(fs.readdirSync(dir).some((f) => f.startsWith("db.json.bak-")), "原文件要留备份");
  fs.rmSync(dir, { recursive: true, force: true });
});

t("toUnix：ISO、分钟精度、缺失三种", () => {
  eq(upstream.toUnix({ timestampIso: "2026-10-04T03:25:52" }), utc(2026, 9, 4, 3, 25, 52));
  eq(upstream.toUnix({ timestampIso: "2026-10-04 03:25" }), utc(2026, 9, 4, 3, 25));
  eq(upstream.toUnix({ timestampText: "2026-10-04 03:25" }), utc(2026, 9, 4, 3, 25));
  eq(upstream.toUnix({}), 0);
});
t("readToken：只认 history-api-token", () => {
  eq(upstream.readToken('<meta name="history-api-token" content="abc123">'), "abc123");
  eq(upstream.readToken('<meta name="landing-status-token" content="x">'), null);
  eq(upstream.readToken(undefined), null);
});
t("fromUpstream：窗口 75/25、数字名反查、链接绝对化", () => {
  const w = { alphaMinutes: 75, swarmMinutes: 25 };
  const row = { id: 1, pokemon: "Breloom", region: "Hoenn", location: "Route 119", timestampIso: "2026-10-04T03:25:52", alphaUrl: "/alpha-list?x=1" };
  const a = normalize.fromUpstream(row, "alpha", w);
  eq(a.tsUnix, utc(2026, 9, 4, 3, 25, 52));
  eq(a.expiresUnix - a.tsUnix, 75 * 60);
  eq(a.pokemonCn, dict.speciesOf("Breloom").cn);
  ok(a.upstreamUrl.startsWith("https://"));
  const sw = normalize.fromUpstream({ ...row, pokemon: "369" }, "swarm", w);
  eq(sw.pokemon, "Relicanth", "数字 pokemon 要还原成英文名");
  eq(sw.expiresUnix - sw.tsUnix, 25 * 60);
});

const bytes = (s) => Buffer.byteLength(s, "utf8");
t("卡片：关键字段、空字段不占行、超长截断", () => {
  const big = push.buildMessage(ev({ note: "x".repeat(4000), reporter: "张三" }), { nowUnix: 1791100100 });
  ok(bytes(big.markdown.content) <= 4096, "必须截到 4096 字节内");
  ok(big.markdown.content.includes("斗笠菇") && big.markdown.content.includes("119号道路"));
  const none = push.buildMessage(ev({ note: "", reporter: "", tier: 0, upstreamUrl: "" }), { nowUnix: 1791100100 });
  ok(!/tier|上报人|备注/.test(none.markdown.content), "空字段不该出现");
  ok(none.markdown.content.includes("1 小时 13 分"), `剩余时间写法：${none.markdown.content.match(/剩余：.*/)[0]}`);
  const soon = push.buildMessage(ev({ expiresUnix: 1791100900 }), { nowUnix: 1791100100 });
  ok(soon.markdown.content.includes("约 13 分"), "不足一小时只显示分钟");
});
t("队列：2 小时新鲜度、去重、上限 300", () => {
  const s = tmpStore();
  const now = Math.floor(Date.now() / 1000);
  const fresh = ev({ key: "F", tsUnix: now - 30, expiresUnix: now + 3600 });
  eq(push.enqueue(s, [fresh, ev({ key: "S", tsUnix: now - 4 * 3600, expiresUnix: now - 3600 })]), 1, "旧点不进队列");
  eq(push.enqueue(s, [fresh]), 0, "重复不进队列");
  push.enqueue(s, Array.from({ length: 400 }, (_, i) => ev({ key: "M" + i, tsUnix: now - i, expiresUnix: now + 60 })));
  ok(s.db.queue.length <= 300, `队列应封顶 300，实际 ${s.db.queue.length}`);
});

t("配置：默认、合并、环境变量优先、掩码", () => {
  conf.writeConfig({ wecom: { webhook: "https://qyapi/?key=abc123456", minTier: 4 } });
  const c = conf.readConfig();
  eq(c.wecom.minTier, 4);
  eq(c.wecom.enabled, true, "未写的字段保默认");
  eq(c.windows.alphaMinutes, 75);
  const m = conf.masked(c);
  eq(m.wecom.webhook, "");
  ok(m.wecom.webhookHint.endsWith("123456"));
  process.env.WECOM_WEBHOOK = "https://env/?key=zzz";
  eq(conf.readConfig().wecom.webhook, "https://env/?key=zzz", "环境变量优先");
  delete process.env.WECOM_WEBHOOK;
  fs.rmSync(conf.FILE, { force: true });
});

t("validate：规范化、地区随地点、天气必填、脏字符与长度", () => {
  const cfg = { publicReport: true };
  const v = local.validate({ kind: "alpha", pokemon: "breloom", location: " route 119 " }, cfg);
  ok(v.ok, v.error);
  eq([v.value.pokemon, v.value.location, v.value.region], ["Breloom", "Route 119", "Hoenn"]);
  const bad = local.validate({ kind: "alpha", pokemon: "breloom", location: "route 119", region: "Kanto" }, cfg);
  eq(bad.value.region, "Hoenn", "地区以地点归属为准");
  ok(!local.validate({ kind: "pheno", pokemon: "Emolga", location: "Abundant Shrine" }, cfg).ok, "特异天气必须带类型");
  ok(!local.validate({ kind: "alpha", pokemon: "Breloom", location: "Route 119" }, { publicReport: false }).ok, "关闭上报要拒");
  const dirty = local.validate({ kind: "alpha", pokemon: "Breloom", location: "Route 119", note: "a\u0000<b>" + "很".repeat(300) }, cfg);
  ok(!/[<>\u0000]/.test(dirty.value.note) && dirty.value.note.length <= 200, "脏字符要清、长度要截");
  ok(!local.validate({ kind: "alpha", pokemon: "NotReal", location: "Route 119" }, cfg).ok, "未知宝可梦要拒");
});

t("术语回落：词表缺项时原样返回且不吞字符", () => {
  const src = "⚠ Has Double-Edge, Head Smash ⚠";
  const out = dict.translateText(src);
  ok(out.startsWith("⚠") && out.endsWith("⚠"), `首尾符号要保留：${out}`);
  ok(out.includes("Has ") || /[，,]/.test(out), `标点和连接词不该被吃掉：${out}`);
  eq(dict.translateText(""), "");
  eq(dict.term("moves", "肯定不存在的招式"), null);
  eq(dict.term("不存在类别", "x"), null);
});
t("requirementFor：算出需要的秘传兽、去掉与地点同名的冗余位置", () => {
  const refdata = require("../src/refdata");
  ok(refdata.requirementCount() > 500, "需求索引条数太少，可能静态表没读到");
  const q = refdata.requirementFor({ kind: "swarm", pokemon: "Relicanth", location: "Tanoby Ruins" });
  ok(q && q.hms.includes("Surf"), `古空棘鱼群蜂应需要冲浪，实际 ${JSON.stringify(q && q.hms)}`);
  ok(q.hmsCn.length === q.hms.length, "hmsCn 与 hms 要一一对应");
  const b = refdata.requirementFor({ kind: "alpha", pokemon: "Breloom", location: "Route 119" });
  ok(b && !/route 119/i.test(b.specific), "specific 不该重复地点本身");
  eq(refdata.requirementFor({ kind: "alpha", pokemon: "NotReal", location: "Nowhere" }), null);
  eq(refdata.requirementFor(null), null);
  const loc = refdata.atLocation("Route 119");
  ok(loc.alpha.length && loc.alpha[0].hmsCn && Array.isArray(loc.alpha[0].movesetCn), "详情页要带中文招式表");
});

t("整句表：上游备注与蛋组命中，没有可核译名的保持英文", () => {
  eq(dict.translateText("Acro Bike required"), "需要越野自行车");
  ok(dict.translateText("**⚠ ADS HAVE RECOIL ⚠**").includes("反伤"), "反伤警告要翻出来");
  eq(dict.term("concepts", "Waterc"), "水中3");
  eq(dict.term("concepts", "Water B"), "水中2");
  /* 这两个值纠正过手写表的错误，钉住防止回退 */
  eq(dict.term("concepts", "Field"), "陆上");
  eq(dict.term("concepts", "Chaos"), "不定形");
  eq(dict.term("concepts", "Cannot Breed"), "未发现");
  eq(dict.term("concepts", "肯定不存在的蛋组"), null);
  const q = require("../src/refdata").requirementFor({ kind: "swarm", pokemon: "Relicanth", location: "Tanoby Ruins" });
  ok(q.hmsCn[0].cn === "冲浪", `HM 应命中术语表：${JSON.stringify(q.hmsCn)}`);
  ok(/舍身冲撞|双刃头锤/.test(q.notes[0]), `备注里的招式名要替换：${q.notes[0]}`);
});

t("静态表刷新落盘的文件名必须等于读取方用的文件名", () => {
  /* 曾经写成了 alpha.json 这类短名，导致定时刷新写进没人读的文件 */
  const readByApp = ["alpha-spawn-data.json", "swarm-spawn-data.json", "pheno-spawn-data.json", "alphapedia-data.json", "pokemon-natdex-map.json", "pokesearch-data.json"];
  const written = Object.values(upstream.STATIC_FILES).sort();
  eq(written, [...readByApp].sort(), "STATIC_FILES 与读取方不一致");
  for (const f of readByApp) ok(fs.existsSync(path.join(UPSTREAM_DIR, f)), `静态表缺失：${f}`);
  ok(!fs.readdirSync(UPSTREAM_DIR).some((f) => /^(alpha|swarm|pheno|alphapedia|natdex)\.json$/.test(f)), "不该残留旧短名文件");
});

t("图鉴图：已本地镜像，且能按 git blob SHA 逐张复核", () => {
  const dir = path.join(ROOT, "public", "assets", "sprites");
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sprite-manifest.json"), "utf8"));
  const uni = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "species-universe.json"), "utf8"));
  const list = JSON.parse(fs.readFileSync(path.join(UPSTREAM_DIR, "pokesearch-data.json"), "utf8"));
  const byName = new Map(list.map((p) => [String(p.name).toLowerCase(), Number(p.id)]));
  const ids = new Set(uni.map((n) => byName.get(String(n).toLowerCase())).filter(Boolean));
  const missing = [...ids].filter((id) => !fs.existsSync(path.join(dir, `${id}.png`)));
  ok(missing.length === 0, `universe ${ids.size} 个编号里缺图：${missing.slice(0, 8).join(",")}`);

  const sha1 = require("crypto").createHash;
  const bad = [];
  const ghost = [];
  for (const [name, rec] of Object.entries(man.files)) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) { ghost.push(name); continue; }
    const buf = fs.readFileSync(f);
    if (buf.readUInt32BE(0) !== 0x89504e47) { bad.push(`${name} 不是 PNG`); continue; }
    if (!rec.verified || sha1("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex") !== rec.sha) bad.push(`${name} SHA 不符`);
  }
  ok(bad.length === 0, `${bad.length} 张图与清单 blob SHA 对不上：${bad.slice(0, 4).join(" ")}`);
  ok(ghost.length === 0, `清单登记了 ${ghost.length} 个磁盘上不存在的文件：${ghost.slice(0, 4).join(" ")}`);
  const one = fs.readFileSync(path.join(dir, "1.png"));
  eq([one.readUInt32BE(16), one.readUInt32BE(20)], [96, 96], "图必须是 96x96");
});

t("企业微信错误码要翻成可操作的中文", () => {
  eq(push.explain({ errcode: 0 }), "", "成功不该给提示");
  ok(push.explain({ errcode: 93000 }).includes("key"), "93000 要说 key 不对");
  ok(push.explain({ errcode: 45009 }).includes("限流"), "45009 要说明是限流、等一分钟再试");
  ok(push.explain({ errcode: -1, errmsg: "connect ETIMEDOUT 1.2.3.4:443" }).includes("出网"), "网络类错误要给排查方向");
  ok(push.explain({ errcode: 40008 }).includes("markdown"), "40008 要说消息类型");
  ok(push.explain({ errcode: 12345 }).includes("12345"), "没见过的码要原样带出来，不许编原因");
});

t("机器人地址的校验与脱敏", () => {
  const cfgmod = require("../src/config");
  const good = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
  eq(cfgmod.webhookProblem(good), null, "合法地址不该报错");
  ok(cfgmod.webhookProblem("").includes("空"), "空地址要说清");
  ok(cfgmod.webhookProblem("abc").includes("URL"), "不是 URL");
  ok(cfgmod.webhookProblem("ftp://qyapi.weixin.qq.com/x").includes("http"), "协议不对");
  ok(cfgmod.webhookProblem("https://qyapi.weixin.qq.com/cgi-bin/webhook/send").includes("key"), "缺 key 要拒");
  ok(cfgmod.webhookProblem("https://qyapi.weixin.qq.com/send?key=a b").includes("空格"), "粘贴带换行/空格要指出来");
  const m = cfgmod.masked({ adminPassword: "123456", wecom: { webhook: good } });
  eq(m.wecom.webhook, "", "脱敏后不能把完整地址回前端");
  ok(m.wecom.webhookHint.endsWith("f3a4b") && !m.wecom.webhookHint.includes("0f9c1a2b"), "只给尾号");
  eq(m.wecom.webhookOffHost, false, "官方域名不算异常");
  const m2 = cfgmod.masked({ adminPassword: "", wecom: { webhook: "http://127.0.0.1:3599/send?key=MOCK" } });
  eq(m2.wecom.webhookOffHost, true, "本机 mock 端点要标出来提醒");
  eq(m2.wecom.webhookSource, process.env.WECOM_WEBHOOK ? "env" : "file", "来源要标对");
});

console.log(`\n单测通过 ${pass}，失败 ${fails.length}${fails.length ? "：" + fails.join(" / ") : ""}`);
process.exit(fails.length ? 1 : 0);
