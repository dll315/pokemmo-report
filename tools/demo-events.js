#!/usr/bin/env node
"use strict";
/* 造几条演示点位，方便在没有真实报点的时段预览界面（也会触发一次推送）。
   需要管理口令：ADMIN_TOKEN=demo-password node tools/demo-events.js [--url=http://127.0.0.1:3999]
   注意：这些点位的来源会标成"玩家上报"，上线后请当作测试数据看待，或直接等 prune 清掉。 */

const BASE = (process.argv.find((a) => a.startsWith("--url=")) || "--url=http://127.0.0.1:3580").split("=")[1];
const TOKEN = process.env.ADMIN_TOKEN || "";

const SAMPLES = [
  { kind: "alpha", pokemon: "Breloom", location: "Route 119", region: "Hoenn", reporter: "演示数据", note: "入口附近草丛，需要怪力" },
  { kind: "swarm", pokemon: "Relicanth", location: "Tanoby Ruins", reporter: "演示数据", note: "水面群蜂，钓竿即可" },
  { kind: "pheno", pokemon: "Emolga", location: "Abundant Shrine", phenoType: "Grass", reporter: "演示数据", note: "丰饶之社草地天气" },
];

async function post(path, body, admin = false) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers["x-admin-token"] = TOKEN;
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  if (!TOKEN) {
    console.error("缺少 ADMIN_TOKEN 环境变量");
    process.exit(1);
  }
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
