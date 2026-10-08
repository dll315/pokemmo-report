"use strict";
/* 译名词表与图鉴号查询。词表由 tools/build-cn-data.js 生成；
   文件缺失时全部回落英文原名，网站照常能跑，不会白屏。 */

const fs = require("fs");
const path = require("path");

const DATA = path.resolve(__dirname, "..", "data");
const FALLBACK_REGIONS = { Hoenn: "丰缘地区", Johto: "城都地区", Kanto: "关都地区", Sinnoh: "神奥地区", Unova: "合众地区" };

let species = {};
let locations = {};
let regions = { ...FALLBACK_REGIONS };
let natdexMap = {};
let terms = { moves: {}, abilities: {}, types: {}, hms: {}, balls: {}, concepts: {} };
let termsIndex = {};
let phrases = new Map();
let placeWords = [];
let loaded = { species: false, locations: false, terms: false };

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
  } catch (e) {
    return null;
  }
}

function reload() {
  const s = readJson("cn-species.json");
  if (s) {
    species = s;
    loaded.species = true;
  }
  const l = readJson("cn-locations.json");
  if (l) {
    locations = l.locations || l;
    if (l.regions) regions = { ...FALLBACK_REGIONS, ...l.regions };
    loaded.locations = true;
  }
  const n = readJson("upstream/pokemon-natdex-map.json");
  if (n) natdexMap = n;

  /* 译名在不同社区/世代叫法不一致（如 Giant Chasm 有"巨人洞窟"和"巨大之洼"两种），
     允许用 data/cn-overrides.json 覆盖，不必改生成脚本 */
  const ov = readJson("cn-overrides.json");
  if (ov) {
    for (const [k, v] of Object.entries(ov.species || {})) if (species[k]) species[k].cn = v;
    for (const [k, v] of Object.entries(ov.locations || {})) if (locations[k]) locations[k].cn = v;
    for (const [cat, map] of Object.entries(ov.terms || {})) if (terms[cat]) terms[cat] = { ...terms[cat], ...map };
    if (ov.regions) regions = { ...regions, ...ov.regions };
  }

  const t = readJson("cn-terms.json");
  if (t) {
    terms = { moves: {}, abilities: {}, types: {}, hms: {}, balls: {}, concepts: {}, ...t };
    loaded.terms = true;
  }
  termsIndex = {};
  textRe = null;
  for (const [cat, map] of Object.entries(terms)) {
    termsIndex[cat] = new Map(Object.entries(map || {}).map(([k, v]) => [k.toLowerCase(), v && v.cn ? halfwidth(v.cn) : null]));
  }

  /* 整句表：上游备注/位置说明/蛋组等自由文本，键就是原文，命中即整句替换 */
  phrases = new Map();
  const ph = readJson("cn-phrases.json");
  if (ph && typeof ph === "object") {
    for (const [en, cn] of Object.entries(ph)) if (typeof cn === "string" && cn) phrases.set(lower(en), halfwidth(cn));
    loaded.phrases = !!phrases.size;
  }

  /* 地点名里的通名词（Chamber→石室 这类），用来兜住字典里没有整条地名的情况。
     只收有整句出处的词，见 data/cn-place-words.json 的 _note；单条编译成词边界正则备用。 */
  placeWords = [];
  const pw = readJson("cn-place-words.json");
  for (const w of (pw && pw.words) || []) {
    if (!w || !w.en || !w.cn) continue;
    placeWords.push({ en: String(w.en).trim(), cn: halfwidth(String(w.cn).trim()), re: new RegExp(`\\b${String(w.en).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi") });
  }
  return loaded;
}

const lower = (v) => String(v || "").trim().toLowerCase();

/* PokeAPI 的 zh-hans 里混用全角数字（如「纹理２」「水中３」），站内统一成半角，
   只动排版不动字形，其它字符原样保留 */
const halfwidth = (v) => String(v ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

function speciesOf(name) {
  const key = lower(name);
  const hit = Object.entries(species).find(([k]) => lower(k) === key);
  if (hit) return { name: hit[0], cn: halfwidth(hit[1].cn) || null, natdex: hit[1].natdex || natdexMap[lower(hit[0])] || null };
  return { name: String(name || "").trim(), cn: null, natdex: natdexMap[key] || null };
}

function locationOf(name) {
  const key = lower(name);
  const hit = Object.entries(locations).find(([k]) => lower(k) === key);
  const exact = hit ? halfwidth(hit[1].cn) || "" : "";
  if (exact) return exact;
  /* 整条地名不在字典里（如阿斯卡纳遗迹的 Rixy / Guidance / Viapois 三间石室）：
     至少把有出处的通名换掉 → "Rixy 石室"，专名保留原文，不自己造词 */
  let out = String(name || "").trim();
  let changed = false;
  for (const w of placeWords) {
    const next = out.replace(w.re, w.cn);
    if (next !== out) { out = next; changed = true; }
  }
  return changed ? halfwidth(out) : null;
}

function regionOf(name) {
  const key = lower(name);
  const hit = Object.entries(regions).find(([k]) => lower(k) === key);
  return hit ? hit[1] : null;
}

/* 术语查询：招式/特性/属性/秘传/精灵球/概念词。类别里没有时再查整句表兜底
   （蛋组名、"需要越野自行车"这类只在语言包/手拍表里出现的说法） */
function term(cat, en) {
  const map = termsIndex[cat];
  if (en === undefined || en === null || en === "") return null;
  const direct = map ? map.get(lower(en)) : null;
  return direct || phrases.get(lower(en)) || null;
}

/* 中文（English）双显，缺译名时只显示原文 */
function termPair(cat, en) {
  const raw = String(en ?? "");
  const cn = term(cat, raw);
  return cn && cn !== raw ? `${cn}（${raw}）` : raw;
}

const concept = (en) => term("concepts", en) || en;

/* 给前端用的扁平小写键词表 */
function termsFlat() {
  const out = {};
  for (const [cat, map] of Object.entries(termsIndex)) {
    out[cat] = {};
    for (const [k, v] of map) if (v) out[cat][k] = v;
  }
  return out;
}

/* 上游备注是英文自由文本（例如 "⚠ HAS RECOIL ⚠"、"Double-Edge, Head Smash"），
   按词边界把招式/特性名替换成中文，认不出的原样保留，不做整句翻译 */
let textRe = null;
function translateText(text) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const exact = phrases.get(lower(raw));
  if (exact) return exact;
  if (textRe === null) {
    const keys = [...new Set([...(termsIndex.moves || new Map()).keys(), ...(termsIndex.abilities || new Map()).keys()])]
      .filter((k) => k.length > 2)
      .sort((a, b) => b.length - a.length);
    textRe = keys.length ? new RegExp(`\\b(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))})\\b`, "gi") : false;
  }
  if (!textRe) return raw;
  return raw.replace(textRe, (m) => term("moves", m) || term("abilities", m) || m);
}

/* 存进 db 的中文名只是缓存：词表更新（补译名、加通名兜底）之后，老数据也要立刻显示对的中文，
   所以读取时按当前词表重算一次。找不到中文就保持原样，让界面回落到英文。 */
function refreshNames(ev) {
  if (!ev || typeof ev !== "object") return ev;
  const l = locationOf(ev.location);
  if (l && l !== ev.locationCn) ev.locationCn = l;
  const s = ev.pokemon ? speciesOf(ev.pokemon) : null;
  if (s && s.cn && s.cn !== ev.pokemonCn) ev.pokemonCn = s.cn;
  const r = ev.region ? regionOf(ev.region) : "";
  if (r && r !== ev.regionCn) ev.regionCn = r;
  return ev;
}

module.exports = { reload, speciesOf, locationOf, regionOf, refreshNames, term, termPair, concept, termsFlat, translateText, loaded, raw: () => terms, DATA };

reload();
