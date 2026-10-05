"use strict";
/* 静态参考数据：把上游三张表整理成下拉选项、地点元信息，以及"这条点位去之前要准备什么"的
   需求索引（秘传兽、上游地图截图、具体位置备注），并挂上中文术语。
   文件缺失时返回空集合，界面降级为可手输、术语回落英文。 */

const fs = require("fs");
const path = require("path");
const dict = require("./dict");

const UP = path.resolve(__dirname, "..", "data", "upstream");
const REGION_ORDER = ["Kanto", "Johto", "Hoenn", "Sinnoh", "Unova"];

let alpha = {};
let swarm = {};
let pheno = {};
let alphapedia = {};
let loaded = false;
let optsCache = null;

const locationIndex = new Map();
const speciesIndex = new Map();
const reqIndex = new Map();

const low = (v) => String(v || "").trim().toLowerCase();
const isUrl = (v) => /^https?:\/\//.test(String(v || ""));
/* 先按整句表翻译（键里含 ** 原样保留），再剥掉伪 markdown，界面是纯文本 */
const plain = (v) => dict.translateText(String(v ?? "")).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

const read = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(UP, name), "utf8"));
  } catch (e) {
    return {};
  }
};

function addSpecies(name, kind) {
  if (!name) return;
  const rec = speciesIndex.get(name) || { kinds: new Set() };
  rec.kinds.add(kind);
  speciesIndex.set(name, rec);
}

function addReq(key, { hms = [], map = "", specific = "", note = "", notes = [], type = "", ability = "", moveset = [], valuable = false }) {
  const rec = reqIndex.get(key) || { hms: new Set(), map: "", specific: "", note: "", notes: new Set(), types: new Set(), moveset: [], ability: "" };
  (hms || []).forEach((h) => rec.hms.add(h));
  if (!rec.map && isUrl(map)) rec.map = String(map).trim();
  if (!rec.specific && specific) rec.specific = String(specific).trim();
  if (!rec.note && note) rec.note = String(note).trim();
  (notes || []).forEach((n) => rec.notes.add(String(n).trim()));
  if (type) rec.types.add(type);
  /* 特性与配招是"去之前该知道的事"：头目会不会秒杀、带不带反伤，玩家要看这两个判断 */
  if (!rec.ability && ability) rec.ability = String(ability).trim();
  if (valuable) rec.valuable = true;
  for (const m of moveset || []) {
    const v = String(m || "").trim();
    if (v && !rec.moveset.includes(v)) rec.moveset.push(v);
  }
  reqIndex.set(key, rec);
}

/* pheno 表按地点索引、不带地区，用其它表回填 */
function regionOfLocation(loc) {
  for (const table of [alpha, swarm]) {
    for (const [region, body] of Object.entries(table || {})) if (body && body[loc]) return region;
  }
  return "";
}

function indexInto(table, kind) {
  if (kind === "pheno") {
    /* pheno 表只有两层：{地点: {天气类型: {Pokemon:[{Name,Notes}], Specific Locations, HMs}}} */
    for (const [loc, types] of Object.entries(table || {})) {
      const rec = locationIndex.get(loc) || { region: regionOfLocation(loc), kinds: new Set(), hms: new Set() };
      rec.kinds.add("pheno");
      for (const [type, info] of Object.entries(types || {})) {
        (info.HMs || []).forEach((h) => rec.hms.add(h));
        const map = (info["Specific Locations"] || []).map((s) => s["Map Link"]).find(isUrl) || "";
        const specific = (info["Specific Locations"] || []).map((s) => s["Specific Location"]).filter(Boolean).join(" / ");
        for (const e of info.Pokemon || []) {
          addSpecies(e.Name, "pheno");
          addReq(`pheno|${low(e.Name)}|${low(loc)}`, { hms: info.HMs, map, specific, notes: e.Notes, type });
        }
      }
      locationIndex.set(loc, rec);
    }
    return;
  }
  for (const [region, body] of Object.entries(table || {})) {
    if (!body || typeof body !== "object") continue;
    for (const [loc, list] of Object.entries(body)) {
      const rec = locationIndex.get(loc) || { region, kinds: new Set(), hms: new Set() };
      rec.kinds.add(kind);
      for (const item of list || []) {
        const d = item.data || {};
        (d.HMs || []).forEach((h) => rec.hms.add(h));
        addSpecies(item.name, kind);
        addReq(`${kind}|${low(item.name)}|${low(loc)}`, {
          hms: d.HMs,
          map: d["Map Link"],
          /* Specific Location 常常就等于地点本身，那种重复信息不该显示 */
          specific: low(d["Specific Location"]) === low(loc) ? "" : d["Specific Location"],
          note: d["Location Notes"],
          notes: d.Notes,
          ability: d.Ability,
          moveset: d.Moveset,
          valuable: !!d.HasValuable,
        });
      }
      locationIndex.set(loc, rec);
    }
  }
}

function reload() {
  alpha = read("alpha-spawn-data.json");
  swarm = read("swarm-spawn-data.json");
  pheno = read("pheno-spawn-data.json");
  alphapedia = read("alphapedia-data.json");
  locationIndex.clear();
  speciesIndex.clear();
  reqIndex.clear();
  indexInto(alpha, "alpha");
  indexInto(swarm, "swarm");
  indexInto(pheno, "pheno");
  optsCache = null;
  loaded = true;
  return loaded;
}
reload();

/* 一条报点"要准备什么"：上游三张表里本来就有，只是之前没露出来 */
function requirementFor(ev) {
  if (!ev || !ev.pokemon || !ev.location) return null;
  const rec = reqIndex.get(`${ev.kind}|${low(ev.pokemon)}|${low(ev.location)}`) || reqIndex.get(`pheno|${low(ev.pokemon)}|${low(ev.location)}`);
  if (!rec) return null;
  const hms = [...rec.hms];
  return {
    hms,
    hmsCn: hms.map((h) => ({ en: h, cn: dict.term("hms", h) || dict.term("moves", h) || "" })),
    map: rec.map,
    specific: plain(rec.specific),
    note: plain(rec.note),
    notes: [...rec.notes].map(plain),
    types: [...rec.types],
    typesCn: [...rec.types].map((t) => dict.termPair("types", t) || t),
    ability: rec.ability || "",
    abilityCn: rec.ability ? dict.termPair("abilities", rec.ability) : "",
    moveset: [...(rec.moveset || [])],
    movesetCn: (rec.moveset || []).map((m) => dict.termPair("moves", m) || m),
    valuable: !!rec.valuable,
  };
}

function options() {
  if (optsCache) return optsCache;
  const byRegion = {};
  for (const [loc, rec] of locationIndex) {
    const r = rec.region || "其它地区";
    byRegion[r] = byRegion[r] || [];
    byRegion[r].push({
      en: loc,
      cn: dict.locationOf(loc),
      kinds: [...rec.kinds],
      hms: [...rec.hms],
      region: r,
      regionCn: dict.regionOf(r),
    });
  }
  for (const list of Object.values(byRegion)) list.sort((a, b) => a.en.localeCompare(b.en));

  optsCache = {
    regions: REGION_ORDER.map((r) => ({ en: r, cn: dict.regionOf(r) })),
    locationsByRegion: byRegion,
    species: [...speciesIndex.keys()].sort((a, b) => a.localeCompare(b)).map((name) => {
      const sp = dict.speciesOf(name);
      return { en: name, cn: sp.cn, natdex: sp.natdex, kinds: [...speciesIndex.get(name).kinds] };
    }),
    phenoTypes: [...new Set(Object.values(pheno).flatMap((loc) => Object.keys(loc || {})))].sort(),
    terms: dict.termsFlat(),
    concepts: { alpha: dict.concept("Alpha"), swarm: dict.concept("Swarm"), pheno: dict.concept("Pheno"), horde: dict.concept("Horde") },
    upstreamLoaded: loaded && !!Object.keys(alpha).length,
  };
  return optsCache;
}

function speciesDetail(name) {
  const hit = Object.entries(alphapedia).find(([k]) => low(k) === low(name));
  const sp = dict.speciesOf(name);
  if (!hit) return { name, cn: sp.cn, natdex: sp.natdex, found: false };
  const [en, v] = hit;
  const how = v.how || {};
  const ballCn = (b) => dict.term("balls", b) || dict.term("balls", String(b).replace(/\s+\d{4}$/, ""));
  return {
    name: en,
    cn: sp.cn,
    natdex: sp.natdex,
    found: true,
    tier: v.tier,
    egg_groups: (v.egg_groups || []).map((g) => ({ en: g, cn: dict.term("concepts", g) })),
    male_ratio: v.male_ratio,
    ability: { en: v.ability, cn: dict.term("abilities", v.ability) },
    how: {
      balls: (how.balls || []).map((b) => ({ ...b, cn: ballCn(b.ball) })),
      spawns: how.spawns || [],
      events: how.events || [],
      raids: how.raids || [],
      evolves_from: how.evolves_from || [],
      breed_from: how.breed_from || [],
    },
  };
}

/* 某个地点能刷哪些 Alpha / 群蜂 / 特异天气，供详情页用；顺带把秘传兽与招式表翻成中文 */
function decorateSpawn(x) {
  const d = x.data || {};
  return {
    ...d,
    name: x.name,
    hmsCn: (d.HMs || []).map((h) => dict.term("hms", h) || dict.term("moves", h) || null),
    movesetCn: (d.Moveset || []).map((m) => dict.term("moves", m) || null),
    abilityCn: dict.term("abilities", d.Ability),
    locationNoteCn: plain(d["Location Notes"]),
    eggGroupsCn: (d["Egg Group"] || []).map((g) => dict.term("concepts", g)),
    notesCn: (d.Notes || []).map(plain),
  };
}

function atLocation(loc) {
  const out = { alpha: [], swarm: [], pheno: [] };
  for (const [, body] of Object.entries(alpha)) for (const [l, list] of Object.entries(body || {})) if (l === loc) out.alpha.push(...(list || []).map(decorateSpawn));
  for (const [, body] of Object.entries(swarm)) for (const [l, list] of Object.entries(body || {})) if (l === loc) out.swarm.push(...(list || []).map(decorateSpawn));
  const p = pheno[loc] || null;
  if (p)
    for (const [type, info] of Object.entries(p))
      out.pheno.push({
        type,
        typeCn: dict.term("concepts", type),
        pokemon: (info.Pokemon || []).map((x) => x.Name),
        hms: info.HMs || [],
        hmsCn: (info.HMs || []).map((h) => dict.term("hms", h) || dict.term("moves", h) || null),
        notes: (info.Pokemon || []).flatMap((x) => x.Notes || []).map(plain),
      });
  return out;
}

module.exports = {
  reload,
  options,
  speciesDetail,
  atLocation,
  requirementFor,
  raw: () => ({ alpha, swarm, pheno }),
  locationCount: () => locationIndex.size,
  requirementCount: () => reqIndex.size,
};
