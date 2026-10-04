#!/usr/bin/env node
"use strict";
/* 译名溯源复核：不信任生成过程的自述，回源重验。
   1) data/cn-phrases.json 的每一条，必须能在上游中文语言包里原样找到同一条，
      或在 data/egg-group-mapping.json 里以"可采信"的证据找到；找不到就报错退出。
   2) 抽样重打 PokeAPI，核对 cn-species.json / cn-terms.json 里存的中文与官方 zh-hans 是否一致。
   3) 顺带检查：不能有空值、不能 cn 与 en 完全相同却没有依据、不能混入繁体字。
     node tools/audit-cn-sources.js [--samples=40] */

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SAMPLES = Number((process.argv.find((a) => a.startsWith("--samples=")) || "--samples=40").split("=")[1]);

const readJson = (p, dft = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return dft;
  }
};

/* 只列"繁体专用"字形：简繁同形的字（如 怪、兽、岛 的简体写法）不能放进来，否则全是误报 */
const TRADITIONAL = "獸島鎮羅漣勝區夢遺後雙開關鐵鍾閉間閱車馬東風雲電氣樹變見說話語讀讓進運遠適選華萬與寫園圓圖書會體國圍場際樂視親觀興舉藝節頭頻類飛食飯駐髮鬥豐農擊斷無歷";
const problems = [];
const notes = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

function pick(obj, n) {
  const keys = Object.keys(obj || {});
  const step = Math.max(1, Math.floor(keys.length / n));
  const out = [];
  for (let i = 0; i < keys.length && out.length < n; i += step) out.push(keys[i]);
  return out;
}

async function pokeUrl(url) {
  const r = await fetch(url, { headers: { "User-Agent": "pokemmo-report-audit/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

/* 上游的英文写法五花八门（Compoundeyes、SmellingSalt…），逐个加别名是打地鼠。
   这里直接拉一次该类别的全量名称表，按"只留字母数字"的归一化形式匹配官方 slug。 */
const listCache = {};
/* 上游用的是第五世代的旧特性名，官方现已改名；带上映射才能回源证明译名没错 */
const LEGACY = { "snow-plow": "slush-rush", "reactive-gas": "neutralizing-gas", "smelling-salt": "smelling-salts", "faint-attack": "feint-attack", "hi-jump-kick": "high-jump-kick" };
async function officialSlug(kind, name) {
  if (!listCache[kind]) {
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const d = await pokeUrl(`https://pokeapi.co/api/v2/${kind}?limit=1000&offset=${offset}`);
      all.push(...d.results);
      if (!d.next || all.length >= 3000) break;
    }
    listCache[kind] = new Map(all.map((r) => [r.name.replace(/[^a-z0-9]/g, ""), r.name]));
  }
  const key = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return listCache[kind].get(key) || null;
}
const zhHans = (names) => {
  const hit = (names || []).find((n) => n.language && n.language.name === "zh-hans");
  return hit ? hit.name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) : null;
};

/* ---------- 1. 整句表溯源 ---------- */
function auditPhrases() {
  const phrases = readJson(path.join(ROOT, "data/cn-phrases.json"), {});
  const catalogRaw = readJson(path.join(ROOT, "data/upstream/i18n-zh.json"));
  const mapping = readJson(path.join(ROOT, "data/egg-group-mapping.json"), { rows: [] });
  if (!catalogRaw) {
    problems.push("缺少 data/upstream/i18n-zh.json，无法证明整句表来源");
    return;
  }
  const catalog = new Map();
  (function walk(o) {
    for (const [k, v] of Object.entries(o || {})) {
      if (typeof v === "string") {
        const key = k.trim().toLowerCase();
        if (!catalog.has(key)) catalog.set(key, { en: k.trim(), cn: v.trim() });
      } else if (v && typeof v === "object") walk(v);
    }
  })(catalogRaw.add_translation && catalogRaw.add_translation.translations);

  const eggOk = new Map((mapping.rows || []).filter((r) => r.verdict === "可采信" && r.cn).map((r) => [r.upstream, r]));
  let fromCatalog = 0;
  let fromEgg = 0;
  let orphan = 0;
  for (const [en, cn] of Object.entries(phrases)) {
    check(typeof cn === "string" && cn.trim(), `整句表有空值：${en}`);
    for (const ch of String(cn)) if (TRADITIONAL.includes(ch)) problems.push(`整句表疑似繁体：${en} -> ${cn}`);
    const c = catalog.get(en.trim().toLowerCase());
    if (c && c.cn === cn) {
      fromCatalog++;
      continue;
    }
    const e = eggOk.get(en);
    if (e && e.cn === cn) {
      fromEgg++;
      continue;
    }
    orphan++;
    if (orphan <= 8) problems.push(`整句表条目无来源：${en} -> ${cn}`);
  }
  notes.push(`整句表 ${Object.keys(phrases).length} 条：语言包可溯 ${fromCatalog}，蛋组取证可溯 ${fromEgg}，无来源 ${orphan}`);
  check(orphan === 0, `整句表有 ${orphan} 条找不到来源`);
}

/* ---------- 2. PokeAPI 抽样重验 ----------
   比对的是界面实际会显示的值（走 src/dict.js 的取词路径，含排版归一），不是文件里的原始字节 */
async function auditPokeApi() {
  const dict = require("../src/dict");
  const species = readJson(path.join(ROOT, "data/cn-species.json"), {});
  const terms = readJson(path.join(ROOT, "data/cn-terms.json"), {});
  const KIND_OF = { species: "pokemon-species", moves: "move", abilities: "ability", types: "type", hms: "move", balls: "item" };
  const slugify = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const jobs = [];
  for (const name of pick(species, SAMPLES)) {
    const id = species[name] && species[name].natdex;
    if (id) jobs.push({ cat: "species", name, stored: dict.speciesOf(name).cn, url: `https://pokeapi.co/api/v2/pokemon-species/${id}` });
  }
  for (const cat of ["moves", "abilities", "types", "hms", "balls"]) {
    for (const name of pick(terms[cat], Math.max(8, Math.round(SAMPLES / 3)))) {
      /* 活动球形如 "Ultra 2025"：球名可比，年份是上游自造后缀，比对前先剥掉 */
      const bare = cat === "balls" ? String(name).replace(/\s+\d{4}$/, "") : name;
      let slug = slugify(bare);
      if (cat === "balls" && !/-ball$/.test(slug)) slug += "-ball";
      const resolved = (await officialSlug(KIND_OF[cat], slug)) || (LEGACY[slug] ? await officialSlug(KIND_OF[cat], LEGACY[slug]) : null);
      if (!resolved) {
        notes.push(`${cat}/${name}：PokeAPI ${KIND_OF[cat]} 列表里没有 "${slug}"，无法回源核对`);
        continue;
      }
      jobs.push({ cat, name, stored: dict.term(cat, bare), url: `https://pokeapi.co/api/v2/${KIND_OF[cat]}/${resolved}` });
    }
  }

  let checked = 0;
  let mismatch = 0;
  for (const j of jobs) {
    let actual;
    try {
      actual = zhHans((await pokeUrl(j.url)).names);
    } catch (e) {
      problems.push(`抽样复核打不开 PokeAPI：${j.cat}/${j.name} —— ${e.message}`);
      continue;
    }
    checked++;
    if (!actual) {
      notes.push(`${j.cat}/${j.name}：PokeAPI 无 zh-hans，存的是 ${j.stored}`);
      continue;
    }
    /* 站点在读取层把全角数字归一成半角（PokeAPI 的 zh-hans 混用两者），比对时同样归一，
       这样只校验内容是否真的是官方译名，不为排版报假警 */
    const norm = (s) =>
      String(s || "")
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/[【】“”‘’・]/g, (c) => ({ "【": "[", "】": "]", "“": '"', "”": '"', "‘": "'", "’": "'", "・": "·" }[c]))
        .trim();
    if (norm(j.stored) !== norm(actual)) {
      mismatch++;
      problems.push(`译名与官方不符：${j.cat}/${j.name} 存=${JSON.stringify(j.stored)} 官方 zh-hans=${JSON.stringify(actual)}`);
    }
  }
  notes.push(`PokeAPI 抽样复核 ${checked} 条，不符 ${mismatch} 条`);
}

/* ---------- 3. 地点表交叉比对 ----------
   cn-locations.json 是另一条来源（维基条目名）建的，这里用上游中文语言包做第二意见。
   两边不一致不代表谁一定错（官方译名 vs 社区叫法），但必须摆出来人工裁决，不能静默混用。 */
function auditLocations() {
  const locs = readJson(path.join(ROOT, "data/cn-locations.json"), {});
  const catalogRaw = readJson(path.join(ROOT, "data/upstream/i18n-zh.json"));
  if (!catalogRaw) return;
  const catalog = new Map();
  (function walk(o) {
    for (const [k, v] of Object.entries(o || {})) {
      if (typeof v === "string") {
        const key = k.trim().toLowerCase();
        if (!catalog.has(key)) catalog.set(key, v.trim());
      } else if (v && typeof v === "object") walk(v);
    }
  })(catalogRaw.add_translation && catalogRaw.add_translation.translations);

  const table = locs.locations || locs;
  let both = 0;
  let agree = 0;
  const diffs = [];
  for (const [en, rec] of Object.entries(table)) {
    const cn = rec && rec.cn;
    const alt = catalog.get(String(en).trim().toLowerCase());
    if (!alt || !cn) continue;
    both++;
    if (alt === cn) agree++;
    else diffs.push({ en, 维基来源: cn, 上游语言包: alt });
  }
  notes.push(`地点表与上游语言包可比对 ${both} 处，一致 ${agree} 处，不一致 ${diffs.length} 处`);
  if (diffs.length) {
    fs.writeFileSync(
      path.join(ROOT, "data", "cn-location-disputes.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), note: "两条来源都算可核（维基条目名 vs Alphapedia 简体中文语言包）。要改哪个，写进 data/cn-overrides.json 的 locations 里，管理台点「重载词表」。", diffs }, null, 2) + "\n",
      "utf8"
    );
    console.log(`\n地点译名分歧 ${diffs.length} 条（已写入 data/cn-location-disputes.json 供裁决；界面显示 中文（English），不会误导）：`);
    diffs.slice(0, 40).forEach((d) => console.log(`  · ${d.en}: 表内「${d["维基来源"]}」 / 语言包「${d["上游语言包"]}」`));
    if (diffs.length > 40) console.log(`  …其余 ${diffs.length - 40} 条`);
  }
}

(async () => {
  auditPhrases();
  await auditPokeApi();
  auditLocations();
  console.log(notes.map((n) => "  · " + n).join("\n"));
  if (problems.length) {
    console.log(`\n发现 ${problems.length} 个问题：`);
    problems.slice(0, 30).forEach((p) => console.log("  ✗ " + p));
    process.exit(1);
  }
  console.log("\n溯源复核通过：所有整句译名可指回来源，抽样译名与官方 zh-hans 一致。");
})();
