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
  const m2 = cfgmod.masked({ adminPassword: "", wecom: { webhook: "http://127.0.0.1:3599/send?key=MOCK", targets: [{ id: "t1", name: "本机", webhook: "http://127.0.0.1:3599/send?key=MOCK", enabled: true }] } });
  eq(m2.wecom.webhookOffHost, true, "本机 mock 端点要标出来提醒");
  eq(m2.wecom.webhookSource, "file", "来源按那条启用的连接判定：配置文件里的算 file");
  const m3 = cfgmod.masked({ adminPassword: "", wecom: { webhook: "https://e/x?key=1", targets: [{ id: "env", name: "环境变量注入", webhook: "https://e/x?key=1", enabled: true, locked: true }] } });
  eq(m3.wecom.webhookSource, "env", "锁定的那条来自环境变量");
  eq(m3.wecom.targets[0].webhook, "", "连接列表里也不能带完整地址");
});

t("连接列表：旧单地址迁移、数组能缩短、环境变量是多加一条而不是覆盖", () => {
  const cfgmod = require("../src/config");
  const savedEnv = process.env.WECOM_WEBHOOK;
  delete process.env.WECOM_WEBHOOK;
  try {
    const one = cfgmod.normalizeTargets({ webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=aaaa1111" });
    eq(one.length, 1, "旧单地址要变成一条连接");
    eq([one[0].id, one[0].enabled], ["legacy", true], "迁移出来的那条默认启用");
    eq(cfgmod.normalizeTargets({ webhook: "https://a/x?key=1", targets: [] }).length, 0, "targets 是空数组 = 真的没有，不能被旧字段复活");
    eq(cfgmod.normalizeTargets({ targets: [{ webhook: "https://a/x?key=1" }, { webhook: "https://a/x?key=1" }] }).length, 1, "同一条地址不重复登记");
    eq(cfgmod.normalizeTargets({ targets: [{ webhook: "" }] }).length, 0, "空地址不登记");

    process.env.WECOM_WEBHOOK = "https://env/x?key=eeeeeeee";
    const withEnv = cfgmod.normalizeTargets({ webhook: "https://a/x?key=1" });
    eq(withEnv.length, 2, "环境变量是多加的一条，不是覆盖掉文件里那条");
    eq(withEnv.filter((t) => t.locked).length, 1, "只有 env 那条标锁定");
    eq(withEnv.find((t) => t.locked).enabled, true, "锁定不等于停用");
    eq(cfgmod.normalizeTargets({ webhook: "https://env/x?key=eeeeeeee" }).length, 1, "文件里已是同一条地址时不重复登记");
    eq(cfgmod.normalizeTargets({ webhook: "https://env/x?key=eeeeeeee" })[0].locked, true, "同一条地址只补锁定标记");
    delete process.env.WECOM_WEBHOOK;

    const f = process.env.CONFIG_FILE;
    fs.rmSync(f, { force: true });
    cfgmod.writeConfig({ wecom: { targets: [{ id: "t1", name: "A", webhook: "https://a/x?key=1" }, { id: "t2", name: "B", webhook: "https://b/x?key=2" }] } });
    eq(cfgmod.readConfig().wecom.targets.length, 2, "先写两条");
    cfgmod.writeConfig({ wecom: { targets: [{ id: "t1", name: "A", webhook: "https://a/x?key=1" }] } });
    eq(cfgmod.readConfig().wecom.targets.length, 1, "数组必须能缩短（逐项合并会把第二条留在后面）");
    eq(cfgmod.readConfig().wecom.webhook, "https://a/x?key=1", "老代码读的 webhook 派生自第一条启用的连接");
    cfgmod.writeConfig({ wecom: { targets: [{ id: "t1", name: "A", webhook: "https://a/x?key=1", enabled: false }] } });
    eq(cfgmod.readConfig().wecom.webhook, "", "全停用后派生地址为空，decide() 会当作没配");
    fs.rmSync(f, { force: true });
  } finally {
    if (savedEnv) process.env.WECOM_WEBHOOK = savedEnv;
    else delete process.env.WECOM_WEBHOOK;
  }
});

t("头目推送要报得详细：特性/配招/本波时段/同点其它/本波统计", () => {
  const refdata = require("../src/refdata");
  const req = refdata.requirementFor({ kind: "alpha", pokemon: "Crawdaunt", location: "Abandoned Ship" });
  ok(req.abilityCn && req.abilityCn !== "Adaptability", `特性要有中文名：${req.abilityCn}`);
  ok(req.movesetCn.length >= 3 && !/[A-Za-z]/.test(req.movesetCn[0]), `配招只出中文（英文进不了卡片）：${req.movesetCn && req.movesetCn[0]}`);
  eq(req.hmsCn.length, req.hms.length, "hmsCn 与 hms 一一对应");
  eq(req.hmsCn[0].cn, "冲浪", "hmsCn 必须仍是 {en,cn} 结构（前端与卡片都依赖）");

  const now = Math.floor(Date.now() / 1000);
  const CN = { Crawdaunt: "铁螯龙虾", Ambipom: "双尾怪手", Beedrill: "大针蜂" };
  const ev = (p, loc, tier) => ({ key: `alpha|${p}|${loc}|${now}`, kind: "alpha", source: "upstream", pokemon: p, pokemonCn: CN[p], location: loc, region: "Hoenn", tier, tsUnix: now, expiresUnix: now + 3600 });
  const rows = [ev("Crawdaunt", "Abandoned Ship", 4), ev("Ambipom", "Abandoned Ship", 2), ev("Beedrill", "Route 102", 5)];
  const ctx = push.pushContext({ events: () => ({ rows }) }, now);
  eq([ctx.waveTotal, ctx.waveHigh], [3, 2], "本波统计");
  eq(ctx.samePlace(rows[0]).map((e) => e.pokemon).join(","), "Ambipom", "同点其它头目要排除自己");
  const c = push.buildMessage(rows[0], { nowUnix: now, ctx }).markdown.content;
  ok(/特性：/.test(c), "卡片要有特性");
  ok(/配招：/.test(c), "卡片要有配招");
  ok(/本波：第 \d 波 \d\d:\d\d–\d\d:\d\d/.test(c) || /现在在两波之间/.test(c), `卡片要交代时段（第几波、起止）`);
  ok(/本波共 3 个头目，其中 4 档及以上的 2 个/.test(c), "卡片要有本波统计");
  ok(/同点还有：.*双尾怪手/.test(c), "卡片要列出同点其它头目");
  ok(/★ 上游标记为有价值/.test(c) === !!req.valuable, "有价值标记跟着静态表走，不自造");
  ok(Buffer.byteLength(c, "utf8") <= 4096, "不能超企业微信 markdown 上限");
  const sw = push.buildMessage({ key: "k", kind: "swarm", source: "upstream", pokemon: "Relicanth", location: "Tanoby Ruins", tsUnix: now, expiresUnix: now + 900 }, { nowUnix: now, ctx });
  ok(!/本波共/.test(sw.markdown.content), "群蜂卡片不塞头目的波次统计，别把不相关信息堆上去");
});

t("地点通名兜底：Chamber→石室 有整句出处，专名保留原文不造词", () => {
  eq(dict.locationOf("Rixy Chamber"), "Rixy 石室", "Rixy Chamber 应译成 Rixy 石室");
  eq(dict.locationOf("Guidance Chamber"), "Guidance 石室", "Guidance Chamber");
  eq(dict.locationOf("Viapois Chamber"), "Viapois 石室", "Viapois Chamber");
  /* 整条地名命中时不该走兜底，也不该被通名规则二次替换 */
  const tanoby = dict.locationOf("Tanoby Ruins");
  ok(tanoby && !/石室/.test(tanoby), `遗迹整条译名不该被通名规则污染：${tanoby}`);
  eq(dict.locationOf("Rixy Chamber"), "Rixy 石室", "重复调用要幂等（正则带 g 容易踩 lastIndex）");
  eq(dict.locationOf("Not A Real Place At All"), null, "没有任何可核通名命中时返回 null，界面回落英文");

  /* 出处检查：cn-place-words 里每个词都要能在整句表里找到"英文含该词、中文含该译法"的整句 */
  const pw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cn-place-words.json"), "utf8"));
  const ph = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cn-phrases.json"), "utf8"));
  ok(pw.words.length > 0, "通名表不能为空");
  for (const w of pw.words) {
    const hits = Object.entries(ph).filter(([en, cn]) => new RegExp(`\\b${w.en}\\b`, "i").test(en) && String(cn).includes(w.cn));
    ok(hits.length >= 1, `通名 ${w.en}→${w.cn} 在上游整句表里找不到出处，不该收进来`);
    ok(Array.isArray(w.evidence) && w.evidence.length >= 1, `${w.en} 缺少 evidence 字段`);
  }
});

t("词表更新后老数据也要显示中文（读取时重算，不靠入库时的缓存）", () => {
  const dir = path.join(os.tmpdir(), "poke-refresh-" + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({
    version: 1,
    meta: {},
    events: [{ key: "swarm|a|x|1", kind: "swarm", source: "upstream", pokemon: "Aerodactyl", location: "Rixy Chamber", region: "Kanto", tsUnix: Math.floor(Date.now() / 1000), expiresUnix: Math.floor(Date.now() / 1000) + 600 }],
    reports: [], queue: [],
  }));
  const s2 = new Store(dir);
  s2.load();
  const row = s2.events({ limit: 5 }).rows[0];
  eq(row.locationCn, "Rixy 石室", "入库时没写 locationCn，读取要按当前词表补上");
  eq(row.pokemonCn, "化石翼龙", "宝可梦名同理");
  eq(s2.getEvent("swarm|a|x|1").locationCn, "Rixy 石室", "getEvent 也要重算（推送走这条路）");
  ok(s2.events({ q: "石室", limit: 5 }).total >= 1, "按中文搜地点要能命中老数据");
  fs.rmSync(dir, { recursive: true, force: true });
});

t("部署文档里的命令与脚本对得上（守卫串、参数、引用的文件都真实存在）", () => {
  const doc = fs.readFileSync(path.join(ROOT, "DEPLOY.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const sh = (f) => fs.readFileSync(path.join(ROOT, "tools", f), "utf8");
  const sdu = sh("server-docker-upgrade.sh");
  const su = sh("server-update.sh");
  const du = sh("deploy-update.sh");
  const bs = sh("server-bootstrap.sh");

  /* 文档靠 grep 内容守卫决定要不要执行下载来的脚本；守卫串一旦被改名或删掉，
     那条命令会静默什么都不做，用户只看到"没反应"。这是最容易复发的一类不一致。 */
  const guards = [
    ["MOUNT_OVERRIDE", sdu, "4.1 的 grep 守卫"],
    ["PKG_VER", su, "4.3 的 grep 守卫"],
    ["systemd/system/poke.service", bs, "第 6 节的 grep 守卫"],
  ];
  for (const [marker, body, label] of guards) {
    ok(doc.includes(marker), `${label}没有在 DEPLOY.md 里出现`);
    ok(body.includes(marker), `${label}指向的串在脚本里找不到（脚本会拒绝执行）`);
  }

  /* 文档提到的每个 tools/*.sh 必须真的在仓库里，且是同一个可执行脚本 */
  const refs = new Set([...`${doc}\n${readme}`.matchAll(/tools\/([a-z0-9_-]+\.sh)/g)].map((m) => m[1]));
  ok(refs.size >= 4, `文档只引用了 ${refs.size} 个脚本，正则或文档可疑`);
  for (const f of refs) ok(fs.existsSync(path.join(ROOT, "tools", f)), `文档引用了不存在的 tools/${f}`);

  /* 文档写给用户的参数，脚本的 case 分支必须认 */
  ok(/--mount=\S+/.test(doc) && sdu.includes("--mount=*"), "文档给了 --mount= 但 server-docker-upgrade.sh 不认");
  ok(/--reset-admin/.test(doc) && sdu.includes("--reset-admin)"), "文档给了 --reset-admin 但脚本不认");
  ok(/server-update\.sh --check/.test(doc) && su.includes('"--check"'), "文档给了 --check 但 server-update.sh 不认");

  /* 复发了两次的那个坑：把 docker restart 当成更新（镜像不重建，跑的还是旧代码） */
  ok(!su.includes("docker restart pokemmo-report"), "server-update.sh 又叫人 docker restart 了：那不会换镜像");
  ok(!du.includes("docker restart pokemmo-report"), "deploy-update.sh 同上");

  /* 命令里不许出现占位符凭据——占位符会被原样抄成真实密码（实测密码长度 8 就是这么来的） */
  for (const ph of ["换成你自己", "同样的密码", "同样的地址", "<webhook>", "your-key", "YOUR_PASSWORD", "<TOKEN> 换成"]) {
    ok(!doc.includes(ph) && !readme.includes(ph), `文档里又出现占位符：${ph}`);
  }
  /* 机器人地址只能在管理台管：命令里不该带 WECOM_WEBHOOK（<TOKEN> 那条是 git 令牌，允许） */
  for (const [name, body] of [["DEPLOY.md", doc], ["README.md", readme], ["deploy-update.sh", du], ["server-bootstrap.sh", bs]]) {
    ok(!/-e\s+WECOM_WEBHOOK|--wecom-webhook/.test(body), `${name} 又把 webhook 写进命令行里了`);
  }
});

t("可见文本一律中文：有译名就不许带英文尾巴（前端与卡片同一口径）", () => {
  const BILINGUAL = /（[A-Za-z]/; /* 「冲浪（Surf）」这种形态就是玩家说的"不是中文" */
  const ascii = /[A-Za-z]/;
  const cjk = /[㐀-鿿]/;

  /* 1) 上游全量表里出现的每个术语：命中词表的那批必须是纯中文，不带括注 */
  const read = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "data/upstream", n), "utf8"));
  const words = { hms: new Set(), moves: new Set(), abilities: new Set(), types: new Set(), concepts: new Set() };
  const species = new Set();
  for (const f of ["alpha-spawn-data.json", "swarm-spawn-data.json"]) {
    const j = read(f);
    for (const reg of Object.keys(j)) for (const loc of Object.keys(j[reg])) for (const e of j[reg][loc] || []) {
      const d = e.data || {};
      species.add(e.name);
      (d.HMs || []).forEach((x) => words.hms.add(x));
      (d.Moveset || []).forEach((x) => words.moves.add(x));
      if (d.Ability) words.abilities.add(d.Ability);
      (d["Egg Group"] || []).forEach((x) => words.concepts.add(x));
    }
  }
  for (const loc of Object.keys(read("pheno-spawn-data.json"))) for (const t of Object.keys(read("pheno-spawn-data.json")[loc])) words.concepts.add(t);
  /* 属性不在点位表里，从 pokesearch 全量取 */
  const ps = read("pokesearch-data.json");
  for (const k of Object.keys(ps)) (ps[k].types || []).forEach((t) => words.types.add(typeof t === "string" ? t : t.name));

  for (const [cat, set] of Object.entries(words)) {
    const hit = [...set].filter((w) => dict.term(cat, w));
    const dirty = hit.filter((w) => BILINGUAL.test(dict.term(cat, w)) || !cjk.test(dict.term(cat, w)));
    ok(dirty.length === 0, `${cat} 有 ${dirty.length} 个不是纯中文：${dirty.slice(0, 6).join(" | ")}`);
  }
  ok(Object.values(words).every((s) => s.size > 0), "上游表里没取到术语，取样本身失效");

  /* 2) 宝可梦与地点：有中文的那批也不许再拼英文 */
  const mon = [...species].filter((s) => dict.speciesOf(s).cn);
  ok(mon.length > 300, `图鉴命中太少：${mon.length}`);
  ok(mon.every((s) => !ascii.test(dict.speciesOf(s).cn)), "宝可梦中文名里混进了拉丁字母");
  const place = dict.locationOf("Route 119");
  eq(place, "119号道路", "地点整条命中时不该带原文");
  ok(!BILINGUAL.test(dict.locationOf("Abandoned Ship") || ""), "地点名不许「中文（English）」");

  /* 3) 卡片全文：剥掉标签与链接、去掉专名白名单后，不许还剩拉丁字母 */
  const now = Math.floor(Date.now() / 1000);
  const ev = { key: "alpha|c|x|1", kind: "alpha", source: "upstream", pokemon: "Crawdaunt", pokemonCn: "铁螯龙虾", location: "Abandoned Ship", locationCn: "废弃船坞", region: "Hoenn", regionCn: "丰缘地区", tier: 4, tsUnix: now, expiresUnix: now + 3600 };
  const PROPER = /(Alphapedia|PokeMMO)/g; /* 上游站名与游戏名是专名，不算"没翻译" */
  const visible = (s) => s.replace(/<[^>]+>/g, "").replace(/\]\([^)]*\)/g, "").replace(PROPER, "");
  const content = push.buildMessage(ev, { nowUnix: now }).markdown.content;
  const latin = content.split("\n").map(visible).filter((l) => ascii.test(l));
  ok(latin.length === 0, `卡片里还有英文行：${JSON.stringify(latin)}`);
  ok(/地点：废弃船坞/.test(visible(content)) && !/Abandoned Ship/.test(visible(content)), "地点只显示中文，原文不进卡片");
  ok(/头目｜铁螯龙虾/.test(visible(content)), "标题用中文类型名");

  /* 4) 前端源码里不能再出现把英文名拼进括号的写法：「${中文}（${x.en}）」
        （只盯 .en 变量，免得把「成功 19:41（2 分钟前）」这种中文括注误判成双显） */
  for (const f of ["public/app.js", "public/index.html", "public/admin.html", "public/admin.js"]) {
    const srcTxt = fs.readFileSync(path.join(ROOT, f), "utf8");
    ok(!/（\$\{[^}]*\ben\b[^}]*\}）/.test(srcTxt) && !/\$\{[^}]*\}（\$\{[^}]*\ben\b/.test(srcTxt), `${f} 又拼回「中文（英文名）」双显了`);
  }
});

t("订阅规则：名单与地区认中文名，拒绝理由是中文（含错误分支实测）", () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { kind: "alpha", source: "upstream", pokemon: "Breloom", pokemonCn: "斗笠菇", location: "Route 119", locationCn: "119号道路", region: "Hoenn", regionCn: "丰缘地区", tier: 3, tsUnix: now, expiresUnix: now + 1800 };
  const cfgOf = (w) => ({ wecom: { webhook: "https://q/y?key=1", enabled: true, kinds: ["alpha"], minTier: 0, onlyPokemon: [], exceptPokemon: [], regions: [], quietHours: { enabled: false }, ...w } });

  /* 中文名进名单要能命中（以前只认英文，站主照界面填就永远不推） */
  eq(rules.decide(base, cfgOf({ onlyPokemon: ["斗笠菇"] }), now).ok, true, "中文名单没命中");
  eq(rules.decide(base, cfgOf({ onlyPokemon: ["Breloom"] }), now).ok, true, "英文名单不该失效");
  eq(rules.decide(base, cfgOf({ onlyPokemon: ["大针蜂"] }), now).ok, false, "不在名单里却放行了");
  eq(rules.decide(base, cfgOf({ exceptPokemon: ["斗笠菇"] }), now).ok, false, "中文屏蔽名单没生效");
  eq(rules.decide(base, cfgOf({ regions: ["丰缘地区"] }), now).ok, true, "中文地区名没命中");
  eq(rules.decide(base, cfgOf({ regions: ["关都地区"] }), now).ok, false, "地区不匹配却放行了");

  /* 拒绝理由给人看，不许漏 alpha/swarm/tier 这类原始键 */
  for (const [w, want] of [
    [{ kinds: ["swarm"] }, "类型 头目 未订阅"],
    [{ minTier: 5 }, "价值 3 档低于阈值"],
    [{ regions: ["关都地区"] }, "地区 丰缘地区 未订阅"],
  ]) {
    const d = rules.decide(base, cfgOf(w), now);
    eq(d.ok, false, "本该拒绝");
    ok(d.reason.includes(want), `理由应是「${want}」，实际「${d.reason}」`);
    ok(!/(^|[^A-Za-z])(alpha|swarm|tier)([^A-Za-z]|$)/.test(d.reason), `理由里漏了英文原始键：${d.reason}`);
  }
});

t("待审核列表会补中文名（管理台不再显示 Breloom @ Route 119）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poke-list-"));
  const s = new Store(dir);
  s.load();
  const cfg = conf.readConfig();
  const created = require("../src/local").create(s, {
    kind: "alpha", pokemon: "Bellossom", location: "Route 119", region: "Hoenn",
    note: "自检用", reporter: "自检", ip: "127.0.0.1",
  }, cfg);
  ok(created.ok, `上报没被接受：${JSON.stringify(created)}`);
  const row = require("../src/local").list(s, { status: "pending" }).rows[0];
  eq(row.pokemonCn, "美丽花", "待审核行应带中文宝可梦名");
  eq(row.locationCn, "119号道路", "待审核行应带中文地点名");
  /* 词表补全不该把原始字段改掉（审核放行要用英文键回查上游） */
  eq(row.pokemon, "Bellossom", "补中文名不能动原始英文键");
  fs.rmSync(dir, { recursive: true, force: true });
});

t("同步失败提示用中文类型名（起子进程真跑错误分支）", () => {
  const { execFileSync } = require("child_process");
  const script = `
    process.env.UPSTREAM_BASE = "http://127.0.0.1:1";
    process.env.CONFIG_FILE = require("path").join(require("os").tmpdir(), "poke-unit-cfg.json");
    const fs=require("fs"), os=require("os"), path=require("path");
    const { Store } = require("./src/store"); const { syncOnce } = require("./src/sync"); const { readConfig } = require("./src/config");
    (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poke-unit-"));
      const s = new Store(dir); s.load();
      const r = await syncOnce(s, readConfig(), { log: () => {} });
      console.log(JSON.stringify(r.errors));
      fs.rmSync(dir, { recursive: true, force: true });
    })().catch((e) => { console.log("THROW " + e.message); process.exit(1); });`;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  } catch (e) {
    throw new Error(`子进程失败：${e.message} ${e.stdout || ""}`);
  }
  ok(!out.includes("THROW"), `错误分支本身崩了：${out.trim()}`);
  const errs = JSON.parse(out.trim().split("\n").pop());
  ok(errs.length >= 1, "没触发到同步错误，这条测试失效");
  ok(errs.every((x) => /头目|大量出现|奇遇/.test(x)), `错误提示该用中文类型名：${JSON.stringify(errs)}`);
  ok(errs.every((x) => !/(^|[^A-Za-z])(alpha|swarm):/.test(x)), `错误提示里漏了原始键：${JSON.stringify(errs)}`);
  ok(errs.some((x) => /ECONNREFUSED|超时|refused/.test(x)), "技术原因被吃掉了，站主没法判断");
});

t("挂载遮住 data/ 时词表仍从镜像内置目录兜底（服务器上全英文的真因）", () => {
  const { execFileSync } = require("child_process");
  /* 复现 Docker 部署的实际形态：-v 宿主机目录:/app/data 之后，
     可写目录里只有 db.json / config.json / upstream/，cn-*.json 全不见，
     甚至可能留着一个 6 个类别全空的 cn-terms.json 空壳。 */
  const script = `
    const fs=require("fs"), os=require("os"), path=require("path");
    const shadow=fs.mkdtempSync(path.join(os.tmpdir(),"shadow-"));
    fs.writeFileSync(path.join(shadow,"cn-terms.json"), JSON.stringify({moves:{},abilities:{},types:{},hms:{},balls:{},concepts:{}}));
    process.env.DATA_DIR=shadow;
    process.env.DICT_DIR=process.env.REALDATA;
    const d=require("./src/dict");
    console.log(JSON.stringify({
      loaded:d.loaded,
      crobat:d.speciesOf("Crobat").cn,
      loc:d.locationOf("Route 119"),
      hm:d.term("hms","Surf"),
      concept:d.concept("Alpha"),
      phrase:d.translateText("Acro Bike required"),
      chamber:d.locationOf("Rixy Chamber")
    }));
    fs.rmSync(shadow,{recursive:true,force:true});`;
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: { ...process.env, REALDATA: path.join(ROOT, "data") },
    encoding: "utf8",
    timeout: 30000,
  });
  const r = JSON.parse(out.trim().split("\n").pop());
  eq(r.crobat, "叉字蝠", "宝可梦词表没兜住");
  eq(r.loc, "119号道路", "地点词表没兜住");
  eq(r.hm, "冲浪", "术语词表没兜住（空壳文件被当成有效数据了）");
  eq(r.concept, "头目", "概念词没兜住");
  eq(r.phrase, "需要越野自行车", "整句表没兜住");
  eq(r.chamber, "Rixy 石室", "通名表没兜住");
  ok(r.loaded.species && r.loaded.terms && r.loaded.phrases, `loaded 标记不对：${JSON.stringify(r.loaded)}`);
});

/* 文档里写的用例数必须等于本次真实跑出来的数。这个数字今天漂过两次（25→27→29），
   靠人记是记不住的，所以把它变成断言。 */
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const m = readme.match(/纯逻辑单测 (\d+) 组/);
  if (!m) { fails.push("README 里找不到「纯逻辑单测 N 组」"); console.log("  FAIL README 里找不到「纯逻辑单测 N 组」"); }
  else if (Number(m[1]) !== pass) { fails.push("README 的单测组数与实际不符"); console.log(`  FAIL README 写的是 ${m[1]} 组，实际 ${pass} 组 —— 改 README 或删用例，别让它漂`); }
}

console.log(`\n单测通过 ${pass}，失败 ${fails.length}${fails.length ? "：" + fails.join(" / ") : ""}`);
process.exit(fails.length ? 1 : 0);
