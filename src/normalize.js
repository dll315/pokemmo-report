"use strict";
/* 把上游行 / 玩家上报统一成事件对象，并挂上中文与元数据。
   统一字段：tsUnix = 报出时刻，expiresUnix = 报出 + 有效期窗口。 */

const fs = require("fs");
const path = require("path");
const { eventKey } = require("./store");
const { BASE, toUnix } = require("./upstream");
const dict = require("./dict");

const UP = path.resolve(__dirname, "..", "data", "upstream");
let tierIndex = {};
let canonical = {};
let byNatdex = {};

function loadMeta() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(UP, "alphapedia-data.json"), "utf8"));
    for (const [name, v] of Object.entries(a)) {
      tierIndex[String(name).toLowerCase()] = Number(v.tier || 0);
      canonical[String(name).toLowerCase()] = name;
    }
  } catch (e) {
    /* 静态表没拉全时只影响 tier 过滤 */
  }
  /* pokesearch 表同时给出正确大小写的英文名和图鉴号，是名字规范化的首选来源 */
  try {
    const list = JSON.parse(fs.readFileSync(path.join(UP, "pokesearch-data.json"), "utf8"));
    for (const p of list) {
      if (!p || !p.name) continue;
      canonical[String(p.name).toLowerCase()] = p.name;
      if (p.id) byNatdex[String(p.id)] = p.name;
    }
  } catch (e) {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(UP, "pokemon-natdex-map.json"), "utf8"));
      for (const [lower, id] of Object.entries(n)) if (!byNatdex[String(id)]) byNatdex[String(id)] = lower;
    } catch (e2) {
      /* 忽略 */
    }
  }
}
loadMeta();

/* 上游偶发把宝可梦名返回成图鉴号（实测 swarm 行出现 pokemon: "369"），用反向表救回 */
function canon(name) {
  const raw = String(name || "").trim();
  if (/^\d+$/.test(raw) && byNatdex[raw]) return byNatdex[raw];
  return canonical[raw.toLowerCase()] || raw;
}

function tierOf(name) {
  return tierIndex[String(name || "").toLowerCase()] ?? 0;
}

/* 上游历史接口的 timestamp 语义是"报出时刻"（UTC）：
   用 Relicanth 那条对过账——报出 07:17:22，页面在 07:26:40 显示"还剩 16 分"，正好是 +25 分钟窗口。
   所以有效期 = 报出 + 窗口（Alpha 75 分钟、Swarm 最多 25 分钟，取自上游前端常量）。 */

function fromUpstream(row, kind, windows) {
  const tsUnix = toUnix(row);
  const pokemon = canon(row.pokemon);
  const sp = dict.speciesOf(pokemon);
  const minutes = kind === "alpha" ? windows.alphaMinutes : windows.swarmMinutes;
  return {
    key: eventKey({ kind, pokemon, location: row.location, tsUnix }),
    kind,
    source: "upstream",
    srcId: row.id ?? null,
    pokemon,
    pokemonCn: sp.cn,
    natdex: sp.natdex,
    region: row.region || "",
    regionCn: dict.regionOf(row.region),
    location: row.location || "",
    locationCn: dict.locationOf(row.location),
    note: "",
    tsUnix,
    expiresUnix: tsUnix ? tsUnix + minutes * 60 : 0,
    tier: tierOf(pokemon),
    upstreamUrl: row.alphaUrl ? BASE + row.alphaUrl : "",
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function fromLocalReport(rep, windows) {
  const kind = rep.kind === "pheno" ? "pheno" : rep.kind === "swarm" ? "swarm" : "alpha";
  const pokemon = canon(rep.pokemon);
  const sp = dict.speciesOf(pokemon);
  const now = Math.floor(Date.now() / 1000);
  /* 玩家报点以提交时刻为报出时间，窗口沿用上游同一套常量 */
  const minutes = kind === "swarm" ? windows.swarmMinutes : windows.alphaMinutes;
  const tsUnix = Number(rep.tsUnix) || now;
  return {
    key: eventKey({ kind, pokemon, location: rep.location, tsUnix, phenoType: rep.phenoType || "" }),
    kind,
    source: "local",
    reportId: rep.id,
    pokemon,
    pokemonCn: sp.cn,
    natdex: sp.natdex,
    region: rep.region || "",
    regionCn: dict.regionOf(rep.region),
    location: rep.location || "",
    locationCn: dict.locationOf(rep.location),
    phenoType: rep.phenoType || "",
    note: String(rep.note || "").slice(0, 200),
    reporter: String(rep.reporter || "").slice(0, 24),
    tsUnix,
    expiresUnix: tsUnix + minutes * 60,
    tier: tierOf(pokemon),
    upstreamUrl: "",
    createdAt: now,
  };
}

module.exports = { fromUpstream, fromLocalReport, canon, tierOf, canonical: () => canonical };
