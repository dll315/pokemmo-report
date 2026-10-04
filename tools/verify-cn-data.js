#!/usr/bin/env node
/**
 * tools/verify-cn-data.js
 *
 * Checks the generated Chinese tables against the upstream PokeMMO data:
 *
 *   (a) every species name in data/species-universe.json has a non-null `cn`
 *       in data/cn-species.json
 *   (b) every location key in the three upstream spawn-data files exists in
 *       data/cn-locations.json
 *   (c) no Traditional-Chinese characters leaked into any `cn` field
 *
 * Also sanity-checks the structure, the Route N rule and the region map, then
 * prints a coverage report (total / filled / null) and lists every entry that
 * ended up null so it can be hand-filled.
 *
 * Exit code 0 = all blocking assertions passed, 1 = something failed.
 * Warnings (null coverage) do not fail the run.
 *
 * Node 20+, built-in modules only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UPSTREAM = path.join(DATA, 'upstream');

/* ---------------------------------------------------------------- console -- */

try {
  if (typeof process.stdout.setDefaultEncoding === 'function') {
    process.stdout.setDefaultEncoding('utf8');
  }
} catch {
  /* noop */
}

const CONSOLE_IS_UTF8 = /utf-?8/i.test(
  `${process.env.LANG || ''}${process.env.LC_ALL || ''}${process.env.LC_CTYPE || ''}${process.env.QODER_CONSOLE_UTF8 || ''}`
);

function asciiSafe(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out += c < 128 ? ch : '\\u' + c.toString(16).padStart(4, '0');
  }
  return out;
}

function say(line) {
  process.stdout.write((CONSOLE_IS_UTF8 ? line : asciiSafe(line)) + '\n');
}

/* ------------------------------------------------------------------ utils -- */

function loadJson(file) {
  if (!fs.existsSync(file)) throw new Error(`missing required file: ${path.relative(ROOT, file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const CN_CHARS = (s) => Array.from(s || '').filter((c) => /[㐀-鿿]/.test(c));

/**
 * Traditional-only characters with their Simplified counterpart. A hit is
 * unambiguous: none of these are written this way in standard Simplified
 * Chinese. This is deliberately a blacklist, not a full converter - it covers
 * the characters that realistically show up in Pokémon place/species names.
 */
const TRAD_TO_SIMP = {
  个: '個', 们: '們', 来: '來', 后: '後', 过: '過', 这: '這', 东: '東', 车: '車', 马: '馬',
  鸟: '鳥', 龙: '龍', 门: '門', 问: '問', 开: '開', 关: '關', 间: '間', 点: '點', 线: '線',
  经: '經', 验: '驗', 还: '還', 进: '進', 远: '遠', 动: '動', 场: '場', 学: '學', 习: '習',
  国: '國', 语: '語', 说: '說', 话: '話', 请: '請', 谢: '謝', 让: '讓', 谁: '誰', 儿: '兒',
  风: '風', 云: '雲', 飞: '飛', 万: '萬', 专: '專', 业: '業', 从: '從', 会: '會', 岛: '島',
  队: '隊', 灯: '燈', 烧: '燒', 丽: '麗', 梦: '夢', 遗: '遺', 树: '樹', 罗: '羅', 涟: '漣',
  镇: '鎮', 区: '區', 胜: '勝', 广: '廣', 厂: '廠', 织: '織', 机: '機', 电: '電', 气: '氣',
  战: '戰', 对: '對', 斗: '鬥', 竞: '競', 优: '優', 娱: '娛', 乐: '樂', 游: '遊', 运: '運',
  营: '營', 养: '養', 击: '擊', 变: '變', 观: '觀', 规: '規', 则: '則', 试: '試', 发: '發',
  闭: '閉', 录: '錄', 归: '歸', 乱: '亂', 济: '濟', 满: '滿', 没: '沒', 准: '準', 烟: '煙',
  尔: '爾', 状: '狀', 独: '獨', 环: '環', 现: '現', 琼: '瓊', 画: '畫', 当: '當', 监: '監',
  确: '確', 码: '碼', 礼: '禮', 种: '種', 称: '稱', 简: '簡', 头: '頭', 夹: '夾', 夺: '奪',
  宫: '宮', 寻: '尋', 将: '將', 岁: '歲', 师: '師', 带: '帶', 干: '幹', 几: '幾', 库: '庫',
  应: '應', 庙: '廟', 厅: '廳', 废: '廢', 张: '張', 忆: '憶', 怀: '懷', 悬: '懸', 惊: '驚',
  护: '護', 报: '報', 权: '權', 欢: '歡', 历: '歷', 垒: '壘', 弯: '彎', 显: '顯', 边: '邊',
  际: '際', 难: '難', 号: '號', 与: '與', 于: '於', 桥: '橋', 湾: '灣', 泽: '澤', 沟: '溝',
  涧: '澗', 猎: '獵', 兽: '獸', 灵: '靈', 宝: '寶', 钢: '鋼', 铁: '鐵', 银: '銀', 铜: '銅',
  镜: '鏡', 墙: '牆', 兰: '蘭', 苏: '蘇', 萝: '蘿', 盖: '蓋', 鲁: '魯', 华: '華', 蓝: '藍',
  绿: '綠', 黄: '黃', 红: '紅', 紫: '紫', 龟: '龜', 贝: '貝', 叶: '葉', 迹: '蹟', 闸: '閘',
  浅: '淺', 径: '徑', 阁: '閣', 馆: '館', 齐: '齊', 连: '連', 凤: '鳳', 萨: '薩', 奥: '奧',
  岩: '巖', 见: '見', 觉: '覺', 实: '實', 数: '數', 类: '類', 识: '識', 认: '認', 误: '誤',
  无: '無', 产: '產', 读: '讀', 写: '寫', 词: '詞', 声: '聲', 听: '聽', 导: '導', 层: '層',
  属: '屬', 冈: '岡', 岚: '嵐', 园: '園', 图: '圖', 书: '書', 圣: '聖', 妇: '婦', 孙: '孫',
  系: '係', 备: '備', 证: '證', 构: '構', 复: '復', 顾: '顧', 钟: '鐘', 艺: '藝', 节: '節',
  荆: '荊', 芦: '蘆', 苹: '蘋', 药: '藥', 茎: '莖', 茧: '繭', 蚕: '蠶',
};

// Invert: Traditional -> Simplified, dropping entries where both forms are the
// same character (they can never be a real Traditional leak).
const TRADITIONAL = {};
for (const [simp, trad] of Object.entries(TRAD_TO_SIMP)) {
  if (simp !== trad) TRADITIONAL[trad] = simp;
}

function findTraditional(value) {
  const hits = [];
  for (const ch of CN_CHARS(value)) {
    if (TRADITIONAL[ch]) hits.push({ ch, simp: TRADITIONAL[ch] });
  }
  return hits;
}

/* ------------------------------------------------------------- assertion -- */

const failures = [];
const warnings = [];

function check(label, ok, detail) {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function warn(label, detail) {
  say(`WARN  ${label}${detail ? ` - ${detail}` : ''}`);
  warnings.push(label);
}

function coverageReport(title, entries) {
  const total = entries.length;
  const filled = entries.filter((e) => typeof e.cn === 'string' && e.cn.trim());
  const nulls = entries.filter((e) => !filled.includes(e));
  say('');
  say(`=== coverage: ${title} ===`);
  say(`  total : ${total}`);
  say(`  filled: ${filled.length}`);
  say(`  null  : ${nulls.length}`);
  if (nulls.length) {
    say(`  null entries (${nulls.length}):`);
    for (const n of nulls) say(`    - ${n.key}`);
  }
  return { total, filled: filled.length, nulls: nulls.length, nullList: nulls.map((n) => n.key) };
}

/* ------------------------------------------------------------------- main -- */

say(`verify-cn-data  (${CONSOLE_IS_UTF8 ? 'utf-8 console' : 'ascii-escaped console; files are utf-8'})`);

const species = loadJson(path.join(DATA, 'cn-species.json'));
const locationsDoc = loadJson(path.join(DATA, 'cn-locations.json'));
const universe = loadJson(path.join(DATA, 'species-universe.json'));
const pokesearch = loadJson(path.join(UPSTREAM, 'pokesearch-data.json'));

const locations = locationsDoc.locations;
const regions = locationsDoc.regions;

say('');
say('--- structure ---');
check('cn-species.json is a plain object', !!species && !Array.isArray(species));
check('cn-locations.json wraps { locations, regions }', !!locations && !!regions,
  Object.keys(locationsDoc).join(', '));

/* (a) species universe coverage ------------------------------------------- */

const speciesKeys = Object.keys(species);
const universeMissing = universe.filter((n) => !Object.prototype.hasOwnProperty.call(species, n));
const universeNull = universe.filter((n) => species[n] && !species[n].cn);

say('');
say('--- (a) species-universe.json vs cn-species.json ---');
check(`every name in species-universe.json has an entry (${universe.length} names)`,
  universeMissing.length === 0,
  universeMissing.length ? `absent: ${universeMissing.join(', ')}` : 'all present');
check('every species-universe name resolved to a non-null cn',
  universeNull.length === 0,
  universeNull.length ? universeNull.join(', ') : `${universe.length}/${universe.length} filled`);

// The table is meant to cover all 649 upstream species, not only the 483 in the universe.
const expectedSpecies = new Set(pokesearch.map((p) => p.name));
const speciesAbsent = [...expectedSpecies].filter((n) => !Object.prototype.hasOwnProperty.call(species, n));
check(`all ${expectedSpecies.size} pokesearch species present`,
  speciesAbsent.length === 0, speciesAbsent.length ? speciesAbsent.join(', ') : 'ok');

const natdexBad = speciesKeys.filter((k) => {
  const row = pokesearch.find((p) => p.name === k);
  return row && species[k].natdex !== row.id;
});
check('natdex numbers match pokesearch-data.json', natdexBad.length === 0,
  natdexBad.length ? natdexBad.slice(0, 10).join(', ') : 'ok');

const hant = speciesKeys.filter((k) => species[k].variant === 'hant');
const noChinese = speciesKeys.filter((k) => !species[k].cn);

/* (b) location coverage ---------------------------------------------------- */

function collectLocationKeys() {
  const keys = new Set();
  for (const name of ['alpha', 'swarm', 'pheno']) {
    const doc = loadJson(path.join(UPSTREAM, `${name}-spawn-data.json`));
    for (const top of Object.keys(doc)) {
      const value = doc[top];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      // alpha/swarm are region-keyed; pheno is location-keyed.
      if (/^(Hoenn|Johto|Kanto|Sinnoh|Unova)$/.test(top)) {
        for (const loc of Object.keys(value)) keys.add(loc);
      } else {
        keys.add(top);
      }
    }
  }
  return [...keys].sort();
}

const upstreamLocations = collectLocationKeys();
const locMissing = upstreamLocations.filter((l) => !Object.prototype.hasOwnProperty.call(locations, l));
const locationKeys = Object.keys(locations);

say('');
say('--- (b) upstream spawn locations vs cn-locations.json ---');
check(`every upstream location key is present (${upstreamLocations.length} keys)`,
  locMissing.length === 0, locMissing.length ? `absent: ${locMissing.join(', ')}` : 'all present');
check('cn-locations.json locations sorted for stable diffs',
  locationKeys.every((k, i) => i === 0 || locationKeys[i - 1] <= k));

const kindBad = locationKeys.filter((k) => !['route', 'special', 'other'].includes(locations[k].kind));
check('every location has kind route|special|other', kindBad.length === 0,
  kindBad.length ? kindBad.slice(0, 10).join(', ') : 'ok');

const routeViolations = locationKeys
  .filter((k) => /^Route (\d+)$/.test(k))
  .filter((k) => k.replace(/^Route (\d+)$/, '$1号道路') !== locations[k].cn);
check('every "Route N" maps to "N号道路"', routeViolations.length === 0,
  routeViolations.length ? routeViolations.slice(0, 10).join(', ') : 'ok');

// Near-duplicate families must be internally consistent.
const consistencyPairs = [
  ['Moor of Icirrus', 'Moor Of Icirrus'],
  ['Giant Chasm', 'Giant Chasm (Cave)'],
  ['Pinwheel Forest', 'Pinwheel Forest (Inner)'],
  ['Pinwheel Forest', 'Pinwheel Forest (Outer)'],
];
const inconsistent = consistencyPairs.filter(([base, child]) => {
  const b = locations[base] && locations[base].cn;
  const c = locations[child] && locations[child].cn;
  return b && c && !c.startsWith(b);
});
check('family/qualification consistency (Moor Of..., Giant Chasm (...), Pinwheel Forest (...))',
  inconsistent.length === 0, inconsistent.map((p) => p.join(' vs ')).join(' | ') || 'ok');

const regionNames = [...new Set(
  ['alpha', 'swarm'].flatMap((n) => Object.keys(loadJson(path.join(UPSTREAM, `${n}-spawn-data.json`))))
)];
const regionMissing = regionNames.filter((r) => !regions[r]);
check(`region map covers every upstream region (${regionNames.join(', ')})`,
  regionMissing.length === 0, regionMissing.length ? `absent: ${regionMissing.join(', ')}` : 'ok');

/* (c) no Traditional characters ------------------------------------------- */

say('');
say('--- (c) Simplified-Chinese check ---');

const tradHits = [];
for (const k of speciesKeys) {
  for (const h of findTraditional(species[k].cn)) tradHits.push(`cn-species:${k} ${h.ch}->${h.simp}`);
}
for (const k of locationKeys) {
  for (const h of findTraditional(locations[k].cn)) tradHits.push(`cn-locations:${k} ${h.ch}->${h.simp}`);
}
for (const r of Object.keys(regions)) {
  for (const h of findTraditional(regions[r])) tradHits.push(`cn-locations:region ${r} ${h.ch}->${h.simp}`);
}
check('no Traditional-Chinese characters in any cn field',
  tradHits.length === 0, tradHits.length ? tradHits.join(' | ') : 'clean');

// zh-hant fallbacks are expected to contain Traditional forms; call them out
// separately rather than treating them as a failure.
if (hant.length) warn(`${hant.length} species fell back to zh-hant (Traditional expected)`, hant.join(', '));

/* coverage reports --------------------------------------------------------- */

const speciesCov = coverageReport('cn-species.json',
  speciesKeys.map((k) => ({ key: k, cn: species[k].cn })));
const locationCov = coverageReport('cn-locations.json',
  locationKeys.map((k) => ({ key: k, cn: locations[k].cn })));

say('');
say('--- variant breakdown (species) ---');
say(`  zh-hans      : ${speciesKeys.length - hant.length - noChinese.length}`);
say(`  zh-hant      : ${hant.length}${hant.length ? ` (${hant.join(', ')})` : ''}`);
say(`  no chinese   : ${noChinese.length}`);

say('');
say('--- kind breakdown (locations) ---');
for (const kind of ['route', 'special', 'other']) {
  const subset = locationKeys.filter((k) => locations[k].kind === kind);
  const filledN = subset.filter((k) => locations[k].cn).length;
  say(`  ${kind.padEnd(7)}: ${filledN}/${subset.length} filled`);
}

say('');
if (failures.length) {
  say(`RESULT: FAIL (${failures.length} assertion(s))`);
  for (const f of failures) say(`  - ${f}`);
  process.exitCode = 1;
} else {
  say('RESULT: PASS');
  say(`  species   : ${speciesCov.filled}/${speciesCov.total} filled, ${speciesCov.nulls} null`);
  say(`  locations : ${locationCov.filled}/${locationCov.total} filled, ${locationCov.nulls} null`);
  if (warnings.length) say(`  ${warnings.length} warning(s) - see above`);
  process.exitCode = 0;
}
