#!/usr/bin/env node
"use strict";
/* 整句汉化上游的自由文本：备注、位置说明、蛋组、天气类型等。
   这些字符串全部能在 Alphapedia 自带的简体中文语言包（data/upstream/i18n-zh.json）里
   原样命中，所以是精确匹配，不是机器翻译，也不会造出不存在的说法。
     node tools/build-cn-phrases.js [--offline]  → data/cn-phrases.json */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UP = path.join(ROOT, "data", "upstream");
const OUT = path.join(ROOT, "data", "cn-phrases.json");
const I18N = path.join(UP, "i18n-zh.json");
const I18N_URL = "https://alpha.pokemmotools.org/static/translations/zh/extra-zh.json";

const readJson = (p, dft = {}) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return dft;
  }
};

/* 语言包是 {add_translation:{translations:{ui:{英文:中文}}}}，拍平成小写键表 */
function flatten(node, out) {
  for (const [k, v] of Object.entries(node || {})) {
    if (typeof v === "string") {
      if (!out.has(k.trim().toLowerCase())) out.set(k.trim().toLowerCase(), v.trim());
    } else if (v && typeof v === "object") flatten(v, out);
  }
  return out;
}

function collectStrings() {
  const set = new Set();
  const push = (s) => {
    const v = String(s ?? "").trim();
    if (v && v.length <= 200) set.add(v);
  };
  const alpha = readJson(path.join(UP, "alpha-spawn-data.json"));
  const swarm = readJson(path.join(UP, "swarm-spawn-data.json"));
  const pheno = readJson(path.join(UP, "pheno-spawn-data.json"));
  const alphapedia = readJson(path.join(UP, "alphapedia-data.json"));

  for (const [, body] of Object.entries(alpha))
    for (const [, list] of Object.entries(body || {}))
      for (const it of list || []) {
        const d = it.data || {};
        push(d["Location Notes"]);
        (d.Notes || []).forEach(push);
        (d.HMs || []).forEach(push);
        (d["Egg Group"] || []).forEach(push);
      }
  for (const [, body] of Object.entries(swarm))
    for (const [, list] of Object.entries(body || {}))
      for (const it of list || []) {
        const d = it.data || {};
        push(d["Location Notes"]);
        (d.Notes || []).forEach(push);
        (d.HMs || []).forEach(push);
        (d["Egg Group"] || []).forEach(push);
      }
  for (const [, types] of Object.entries(pheno))
    for (const [type, info] of Object.entries(types || {})) {
      push(type);
      (info.HMs || []).forEach(push);
      for (const p of info.Pokemon || []) (p.Notes || []).forEach(push);
      for (const s of info["Specific Locations"] || []) push(s["Specific Location"]);
    }
  for (const v of Object.values(alphapedia)) {
    (v.egg_groups || []).forEach(push);
    (v.how?.balls || []).forEach((b) => {
      push(b.ball);
      push(String(b.ball || "").replace(/\s+\d{4}$/, ""));
    });
  }
  ["Kanto", "Johto", "Hoenn", "Sinnoh", "Unova", "Alpha", "Swarm", "Pheno", "Horde"].forEach(push);
  return [...set];
}

async function ensureCatalog() {
  if (fs.existsSync(I18N)) return readJson(I18N);
  if (process.argv.includes("--offline")) {
    console.error("缺少 data/upstream/i18n-zh.json 且处于 --offline");
    process.exit(1);
  }
  const r = await fetch(I18N_URL, { headers: { "User-Agent": "pokemmo-report/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`语言包拉取失败 HTTP ${r.status}`);
  const j = await r.json();
  fs.writeFileSync(I18N, JSON.stringify(j), "utf8");
  console.log(`语言包已保存到 ${path.relative(ROOT, I18N)}`);
  return j;
}

/* 蛋组名既不在语言包里、也不在 PokeAPI 的招式/特性表里，改由 tools/audit-egg-groups.js 取证：
   它按宝可梦的成员归属推出"上游黑话 = 哪个官方蛋组"，并直接取该蛋组的 PokeAPI zh-hans 名。
   只接受 verdict === "可采信" 的行，其余保持英文，不用手拍的译名。
   （正是这份取证纠正了手写表的错误：Field 官方作「陆上」而非「场地」。） */
function loadEggGroupMap() {
  const m = readJson(path.join(ROOT, "data", "egg-group-mapping.json"));
  if (!m || !Array.isArray(m.rows)) return {};
  const out = {};
  for (const r of m.rows) if (r.verdict === "可采信" && r.cn) out[r.upstream] = r.cn;
  return out;
}

async function main() {
  const catalog = flatten((await ensureCatalog()).add_translation?.translations || {}, new Map());
  const EGG = loadEggGroupMap();
  const strings = collectStrings();
  const out = {};
  const misses = [];
  let fromCatalog = 0;
  let fromEgg = 0;
  for (const s of strings) {
    const hit = catalog.get(s.toLowerCase());
    if (hit) {
      out[s] = hit;
      fromCatalog++;
    } else if (EGG[s]) {
      out[s] = EGG[s];
      fromEgg++;
    } else misses.push(s);
  }
  const sorted = {};
  for (const k of Object.keys(out).sort((a, b) => a.localeCompare(b))) sorted[k] = out[k];
  fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  console.log(`来源统计：上游中文语言包整句命中 ${fromCatalog} 条，蛋组取证命中 ${fromEgg} 条，共 ${Object.keys(sorted).length} 条`);
  if (misses.length) console.log(`未命中 ${misses.length} 条（界面回落英文）：\n  ${misses.slice(0, 25).join("\n  ")}`);
  console.log(`写出 ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main().catch((e) => (console.error(e.message), process.exit(1)));
module.exports = { main, flatten, collectStrings };
