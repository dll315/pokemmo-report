#!/usr/bin/env node
"use strict";
/* 蛋组名取证：上游用 PokeMMO 黑话（Water A/B/C、Chaos…），官方简中名要按宝可梦的蛋组归属推。
   做法：
     1) 取每个上游标签下的宝可梦集合；
     2) 取 PokeAPI 各蛋组的成员集合与其中文名（zh-hans，全角数字归一化成半角）；
     3) 用"包含率" = |上游集合 ∩ 官方成员| / |上游集合| 选最优匹配（上游只是官方集合的子集，
        Jaccard 会被两边规模差惩罚，所以这里用包含率）；
     4) 把证据（包含率、重合数、次优候选、样本）写进 data/egg-group-mapping.json 供人工复核。
   build-cn-phrases.js 会读这份映射来补蛋组译名，不再依赖手拍表。
     node tools/audit-egg-groups.js [--offline] */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "data", "egg-group-mapping.json");
const CACHE = path.join(__dirname, ".egg-cache");

const readJson = (p, dft = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return dft;
  }
};

async function getJson(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = path.join(CACHE, url.replace(/[^a-z0-9]/gi, "_") + ".json");
  const cached = readJson(key);
  if (cached) return cached;
  if (process.argv.includes("--offline")) throw new Error(`离线且无缓存: ${url}`);
  const r = await fetch(url, { headers: { "User-Agent": "pokemmo-report-audit/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const j = await r.json();
  fs.writeFileSync(key, JSON.stringify(j), "utf8");
  return j;
}

/* 官方 zh-hans 里 water3 写作「水中３」（全角），界面统一成半角数字，其它字符原样 */
const zhHans = (names) => {
  const hit = (names || []).find((n) => n.language && n.language.name === "zh-hans");
  return hit ? hit.name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) : null;
};

/* 上游标签 -> 携带该标签的宝可梦集合 */
function upstreamSets() {
  const sets = {};
  const add = (label, name) => {
    if (!label || !name) return;
    const k = String(label).trim();
    (sets[k] = sets[k] || new Set()).add(String(name).trim().toLowerCase());
  };
  for (const f of ["alpha-spawn-data.json", "swarm-spawn-data.json"]) {
    const t = readJson(path.join(ROOT, "data/upstream", f), {});
    for (const [, body] of Object.entries(t))
      for (const [, list] of Object.entries(body || {})) for (const it of list || []) for (const g of (it.data || {})["Egg Group"] || []) add(g, it.name);
  }
  for (const [name, v] of Object.entries(readJson(path.join(ROOT, "data/upstream/alphapedia-data.json"), {}))) for (const g of v.egg_groups || []) add(g, name);
  return sets;
}

async function main() {
  const list = await getJson("https://pokeapi.co/api/v2/egg-group?limit=60");
  const official = {};
  for (const g of list.results) {
    const d = await getJson(`https://pokeapi.co/api/v2/egg-group/${g.name}`);
    official[g.name] = {
      members: new Set((d.pokemon_species || []).map((p) => p.name.toLowerCase())),
      cn: zhHans(d.names),
    };
  }

  const rows = [];
  for (const [label, set] of Object.entries(upstreamSets())) {
    const scored = Object.entries(official)
      .map(([name, o]) => {
        let inter = 0;
        for (const x of set) if (o.members.has(x)) inter++;
        return { name, cn: o.cn, contain: +(inter / set.size).toFixed(3), inter, ofSize: o.members.size };
      })
      .sort((a, b) => b.contain - a.contain || a.name.localeCompare(b.name));
    const best = scored[0];
    const second = scored[1];
    rows.push({
      upstream: label,
      official: best.name,
      cn: best.cn,
      containment: best.contain,
      overlap: `${best.inter}/${set.size}`,
      runnerUp: second ? `${second.name}(${second.contain})` : "",
      verdict: best.contain >= 0.85 ? "可采信" : best.contain >= 0.5 ? "存疑，需人工看样本" : "无法对应",
      samples: [...set].slice(0, 8),
    });
  }
  rows.sort((a, b) => a.upstream.localeCompare(b.upstream));
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), method: "包含率 = 上游该标签的宝可梦中属于该官方蛋组的比例；中文名取 PokeAPI zh-hans", rows }, null, 2) + "\n", "utf8");
  for (const r of rows) console.log(`${r.upstream.padEnd(13)} → ${(r.cn || "?").padEnd(5)} (${r.official}) 包含率${r.containment} 重合${r.overlap} 次优:${r.runnerUp} ${r.verdict}`);
  const bad = rows.filter((r) => r.verdict !== "可采信");
  console.log(`\n写出 ${path.relative(ROOT, OUT)}；未达"可采信"的有 ${bad.length} 个：${bad.map((b) => b.upstream).join(", ") || "无"}`);
}

if (require.main === module) main().catch((e) => (console.error(e.message), process.exit(1)));
