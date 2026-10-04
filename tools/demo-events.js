#!/usr/bin/env node
"use strict";
/* 造几条演示点位，方便在没有真实报点的时段预览界面（也会触发一次推送）。
   需要管理台账号：ADMIN_USER=admin ADMIN_PASSWORD=123456 node tools/demo-events.js [--url=…]
   注意：这些点位的来源会标成"玩家上报"，上线后请当作测试数据看待，或直接等 prune 清掉。 */

const BASE = (process.argv.find((a) => a.startsWith("--url=")) || "--url=http://127.0.0.1:3580").split("=")[1];
const USER = process.env.ADMIN_USER || "admin";
const PASS = process.env.ADMIN_PASSWORD || "123456";
let cookie = "";

const SAMPLES = [
  { kind: "alpha", pokemon: "Breloom", location: "Route 119", region: "Hoenn", reporter: "演示数据", note: "入口附近草丛，需要怪力" },
  { kind: "swarm", pokemon: "Relicanth", location: "Tanoby Ruins", reporter: "演示数据", note: "水面群蜂，钓竿即可" },
  { kind: "pheno", pokemon: "Emolga", location: "Abundant Shrine", phenoType: "Grass", reporter: "演示数据", note: "丰饶之社草地天气" },
];

async function post(path, body, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (admin && cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  const lg = await fetch(BASE + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: USER, password: PASS }) });
  if (!lg.ok) {
    console.error("登录失败（" + lg.status + "）：" + (await lg.text()));
    console.error("确认服务端的管理账号密码，用 ADMIN_USER / ADMIN_PASSWORD 传给本脚本");
    process.exit(1);
  }
  cookie = (lg.headers.get("set-cookie") || "").split(";")[0];
  const ids = [];
  for (const s of SAMPLES) {
    const r = await post("/api/report", s);
    console.log(r.ok ? `上报通过校验 ${s.pokemon} @ ${s.location} -> ${r.id} (${r.status})` : `上报被拒：${r.error}`);
    if (r.ok) ids.push(r.id);
  }
  for (const id of ids) {
    const a = await post("/api/admin/approve", { id }, true);
    console.log(a.ok ? `已放行 ${a.event.pokemonCn || a.event.pokemon}，失效于 ${new Date(a.event.expiresUnix * 1000).toISOString().slice(11, 19)}Z` : `放行失败：${a.error}`);
  }
  const f = await post("/api/admin/flush", {}, true);
  console.log(`推送队列：发出 ${f.sent} 条，失败 ${f.failed} 条${f.skipped ? "（" + f.skipped + "）" : ""}`);
  const board = await (await fetch(BASE + "/api/board")).json();
  console.log(`看板现有活动点位 ${board.stats.active} 条`);
})().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
