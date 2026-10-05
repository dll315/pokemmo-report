#!/usr/bin/env node
"use strict";
/* 接口冒烟测试：对着一个正在跑的实例打一遍所有路由与关键分支，退出码非 0 就有问题。
   用法：先起服务，再
     ADMIN_USER=admin ADMIN_PASSWORD=123456 node tools/selftest.js --url=http://127.0.0.1:3580
   只读为主，会产生的副作用：提交并驳回一条测试上报、（配了 webhook 时）发一条测试推送。 */

const BASE = (process.argv.find((a) => a.startsWith("--url=")) || "--url=http://127.0.0.1:3580").split("=")[1];
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "123456";

let cookie = "";
let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

async function hit(path, opts = {}) {
  const rest = { ...opts };
  delete rest.admin;
  delete rest.anon;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (!opts.anon && cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, { ...rest, headers });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 保留原文 */ }
  return { status: r.status, json, text, headers: r.headers };
}

/* 登录类请求单独走，免得好密码那次把 cookie 冲掉 */
async function rawPost(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null), sc: r.headers.get("set-cookie") || "" };
}

(async () => {
  console.log(`目标 ${BASE}`);

  /* ---------- 管理台登录 ---------- */
  const bad = await rawPost("/api/admin/login", { user: USER, password: "绝不对的密码" });
  check("错误密码被拒（401）", bad.status === 401, `${bad.status} ${JSON.stringify(bad.json)}`);
  check("错误密码不发会话 cookie", !/admin_session=/.test(bad.sc), bad.sc);
  const good = await rawPost("/api/admin/login", { user: USER, password: PASS });
  if (good.status === 200) cookie = good.sc.split(";")[0];
  check(`用 ${USER}/${PASS === "123456" ? "123456" : "***"} 登录成功`, good.status === 200 && !!cookie, `${good.status} ${JSON.stringify(good.json)}`);
  if (good.status !== 200) console.log(`⚠ 登录不上（${JSON.stringify(good.json)}），管理端用例会被跳过`);

  /* ---------- 公开接口 ---------- */
  const board = await hit("/api/board");
  check("GET /api/board 200", board.status === 200, board.status);
  check("board 字段齐全", ["now", "slots", "alpha", "swarm", "pheno", "stats", "upstream"].every((k) => k in (board.json || {})), Object.keys(board.json || {}).join(","));
  check("board.slots 四段", board.json?.slots?.list?.length === 4, board.json?.slots?.list?.length);
  check("board.stats.active 与三列一致",
    board.json && board.json.stats.active === board.json.alpha.length + board.json.swarm.length + board.json.pheno.length);

  const filtered = await hit("/api/board?region=Hoenn&q=zzzz不存在");
  check("board 筛选生效（bogus 查询应空）", filtered.json?.stats?.active === 0, JSON.stringify(filtered.json?.stats));

  const events = await hit("/api/events?kind=alpha&limit=3");
  check("GET /api/events 200 且分页", events.status === 200 && Array.isArray(events.json?.rows), events.status);
  check("events.limit 生效", (events.json?.rows?.length || 9) <= 3, events.json?.rows?.length);

  const opts = await hit("/api/ref/options");
  check("ref/options 有地区与地点与宝可梦", opts.json?.regions?.length === 5 && Object.keys(opts.json?.locationsByRegion || {}).length >= 5 && opts.json?.species?.length > 100,
    `${opts.json?.regions?.length}/${Object.keys(opts.json?.locationsByRegion || {}).length}/${opts.json?.species?.length}`);
  check("ref/options 中文名已挂载", (opts.json?.species || []).filter((s) => s.cn).length > 300, (opts.json?.species || []).filter((s) => s.cn).length);
  check("地点桶里没有天气名混入", !Object.values(opts.json?.locationsByRegion || {}).flat().some((l) => ["Dust", "Grass", "Shadow", "Water"].includes(l.en)));

  const sp = await hit("/api/ref/species?name=Breloom");
  check("ref/species 命中", sp.json?.found === true && !!sp.json?.cn, JSON.stringify(sp.json || {}).slice(0, 120));
  const loc = await hit("/api/ref/location?name=Route%20119");
  check("ref/location 命中", loc.status === 200 && Array.isArray(loc.json?.detail?.alpha), JSON.stringify(loc.json || {}).slice(0, 80));

  const cfgPub = await hit("/api/config/public");
  check("config/public 不含凭据", cfgPub.status === 200 && !("wecom" in (cfgPub.json || {})) && !("adminPassword" in (cfgPub.json || {})), JSON.stringify(cfgPub.json));
  check("config/public 带有效期窗口", cfgPub.json?.windows?.alphaMinutes > 0 && cfgPub.json?.windows?.swarmMinutes > 0, JSON.stringify(cfgPub.json?.windows));

  /* 需求索引与中文术语 */
  const some = await hit("/api/events?limit=3");
  check("每条事件都带 req 需求字段", (some.json?.rows || []).every((e) => "req" in e), JSON.stringify((some.json?.rows || [])[0] || {}).slice(0, 80));
  check("options 带术语表与概念词", !!opts.json?.terms && typeof opts.json?.concepts?.alpha === "string", JSON.stringify(opts.json?.concepts));
  const withReq = await hit("/api/events?kind=swarm&limit=60");
  const hasReq = (withReq.json?.rows || []).find((e) => e.req && e.req.hms.length);
  check("至少一条报点能查到需要的秘传兽", !!hasReq, "库存里没匹配到，可能数据太旧");

  /* ---------- 静态与防御 ---------- */
  const home = await hit("/");
  check("首页 200", home.status === 200 && home.text.includes("<title>"));
  const adminHtml = await hit("/admin");
  check("管理台 HTML 200", adminHtml.status === 200 && adminHtml.text.includes("管理台登录"));
  const trav = await hit("/../config.json");
  check("目录穿越被挡", trav.status !== 200, trav.status);
  const leak = await hit("/config.json");
  check("config.json 不在站点根下可达", leak.status === 404, leak.status);
  const dbLeak = await hit("/data/db.json");
  check("db.json 不可下载", dbLeak.status === 404, dbLeak.status);
  const notFound = await hit("/api/nope");
  check("未知接口 404", notFound.status === 404);
  const badMethod = await hit("/api/board", { method: "DELETE" });
  check("非法方法 405", badMethod.status === 405, badMethod.status);

  /* ---------- 图鉴图与缓存策略 ---------- */
  const png = await hit("/assets/sprites/1.png");
  check("图鉴图可取且是 PNG", png.status === 200 && png.text.slice(1, 4) === "PNG", png.status);
  check("图片给一周强缓存（文件名即内容）", /max-age=\d{5,}/.test(png.headers.get("cache-control") || ""), png.headers.get("cache-control"));
  check("页面脚本不做强缓存，改了立刻生效", /no-cache/.test((await hit("/app.js")).headers.get("cache-control") || ""));
  const noSprite = await hit("/assets/sprites/999999.png");
  check("缺图返回 404，不回吐 HTML", noSprite.status === 404, noSprite.status);
  const encTrav = await hit("/assets/%2e%2e%2f%2e%2e%2fdata%2fconfig.json");
  check("百分号编码的目录穿越也被挡", encTrav.status === 403 || encTrav.status === 404, encTrav.status);

  /* ---------- 上报校验 ---------- */
  const cases = [
    ["未知宝可梦", { kind: "alpha", pokemon: "NotAPokemon", location: "Route 119" }, /图鉴/],
    ["未知地点", { kind: "alpha", pokemon: "Crobat", location: "Nowhere Land" }, /地点/],
    ["错误类型", { kind: "raid", pokemon: "Crobat", location: "Route 119" }, /类型/],
    ["天气缺类型", { kind: "pheno", pokemon: "Emolga", location: "Abundant Shrine" }, /天气/],
    ["空体", {}, /类型|不存在/],
  ];
  for (const [name, body, re] of cases) {
    const r = await hit("/api/report", { method: "POST", body: JSON.stringify(body) });
    check(`上报被拒：${name}`, r.status === 400 && re.test(r.json?.error || ""), `${r.status} ${JSON.stringify(r.json)}`);
  }

  const ok = await hit("/api/report", { method: "POST", body: JSON.stringify({ kind: "alpha", pokemon: "crobat", location: "route 123", region: "Kanto", reporter: "<script>bad</script>", note: "自检数据" }) });
  check("合法上报进入待审核", ok.json?.ok === true && ok.json?.status === "pending", JSON.stringify(ok.json));

  const dup = await hit("/api/report", { method: "POST", body: JSON.stringify({ kind: "alpha", pokemon: "Crobat", location: "Route 123" }) });
  check("重复上报被合并拒绝", dup.status === 400 && /已经有玩家报/.test(dup.json?.error || ""), JSON.stringify(dup.json));

  /* ---------- 管理端鉴权 ---------- */
  const anon = await hit("/api/admin/state", { anon: true });
  check("未登录访问管理接口被拒", [401, 403].includes(anon.status), anon.status);
  const forged = await hit("/api/admin/state", { anon: true, headers: { Cookie: "admin_session=" + "f".repeat(48) } });
  check("伪造会话 cookie 被拒", forged.status === 401, forged.status);

  if (cookie) {
    const state = await hit("/api/admin/state", { admin: true });
    check("admin/state 200", state.status === 200 && !!state.json?.config && !!state.json?.board, state.status);
    check("admin/state 不回显 webhook 明文", !JSON.stringify(state.json?.config || {}).includes("qyapi") && !String(state.json?.config?.wecom?.webhook || "").length);
    check("admin/state 不回显管理密码", String(state.json?.config?.adminPassword || "").replace(/•/g, "") === "", state.json?.config?.adminPassword);
    check("admin/state 标出弱口令", state.json?.config?.adminPasswordWeak === true, String(state.json?.config?.adminPasswordWeak));

    const pend = (state.json?.reports?.rows || []).find((r) => r.note === "自检数据");
    if (pend) {
      check("小写输入被规范成上游英文名", pend.pokemon === "Crobat" && pend.location === "Route 123", `${pend.pokemon}@${pend.location}`);
      check("上报的地区以地点为准（123 号道路属丰缘）", pend.region === "Hoenn", `region=${pend.region}`);
      check("上报的备注里没有可执行标签", !/<script/i.test(pend.note + pend.reporter), `${pend.note}|${pend.reporter}`);
      const rej = await hit("/api/admin/reject", { method: "POST", admin: true, body: JSON.stringify({ id: pend.id, note: "自检清理" }) });
      check("驳回成功", rej.json?.ok === true, JSON.stringify(rej.json));
    } else check("待审核里能找到自检提交", false, "没找到");

    const sync = await hit("/api/admin/sync", { method: "POST", admin: true, body: "{}" });
    check("手动同步返回统计", sync.json?.ok === true && typeof sync.json.added === "number", JSON.stringify(sync.json).slice(0, 160));
    check("同步无错误", (sync.json?.errors || []).length === 0, JSON.stringify(sync.json?.errors));

    const reload = await hit("/api/admin/reload-dict", { method: "POST", admin: true, body: "{}" });
    check("词表重载 200", reload.json?.ok === true, JSON.stringify(reload.json));

    const cfg = await hit("/api/admin/config", { admin: true });
    check("GET admin/config", cfg.status === 200 && cfg.json?.sync?.intervalMinutes > 0, JSON.stringify(cfg.json?.sync));

    const save = await hit("/api/admin/config", { method: "PUT", admin: true, body: JSON.stringify({ sync: { intervalMinutes: 3 } }) });
    check("PUT admin/config 保存", save.json?.saved === true && save.json?.config?.sync?.intervalMinutes === 3, JSON.stringify(save.json?.config?.sync));
    const back = await hit("/api/admin/config", { method: "PUT", admin: true, body: JSON.stringify({ sync: { intervalMinutes: cfg.json.sync.intervalMinutes } }) });
    check("间隔已还原", back.json?.config?.sync?.intervalMinutes === cfg.json.sync.intervalMinutes);

    const exp = await hit("/api/admin/export", { admin: true });
    check("export 带事件数组", Array.isArray(exp.json?.events), JSON.stringify(exp.json || {}).slice(0, 60));

    const tp = await hit("/api/admin/test-push", { method: "POST", admin: true, body: JSON.stringify({ webhook: "http://127.0.0.1:1/broken" }) });
    check("推送到不可达地址返回错误而不是崩溃", [200, 400].includes(tp.status) && (tp.json?.error || tp.json?.errcode !== 0), `${tp.status} ${JSON.stringify(tp.json).slice(0, 120)}`);
    check("不可达地址要给出中文排查提示", /出网|DNS/.test(tp.json?.hint || ""), JSON.stringify(tp.json?.hint || ""));

    const tpBad = await hit("/api/admin/test-push", { method: "POST", admin: true, body: JSON.stringify({ webhook: "abc" }) });
    check("webhook 不合法时是结构化错误（不是 500）", tpBad.status === 200 && tpBad.json?.errcode === -1 && /不合法/.test(tpBad.json?.errmsg || ""), `${tpBad.status} ${JSON.stringify(tpBad.json).slice(0, 120)}`);

    const flush = await hit("/api/admin/flush", { method: "POST", admin: true, body: "{}" });
    check("flush 返回队列统计", typeof flush.json?.sent === "number", JSON.stringify(flush.json));
  }

  console.log(`\n通过 ${pass}，失败 ${fails.length}${fails.length ? "：" + fails.join(" / ") : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("测试脚本本身出错:", e.message);
  process.exit(2);
});
