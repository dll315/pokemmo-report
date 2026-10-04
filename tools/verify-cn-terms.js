#!/usr/bin/env node
/**
 * tools/verify-cn-terms.js
 *
 * Coverage gate for the terminology table produced by tools/build-cn-terms.js.
 *
 *   (a) every distinct term string found in the upstream data has an entry in
 *       data/cn-terms.json, in the right category:
 *         HMs / Moveset / ability  -> hms, moves, abilities
 *         pokesearch moves + types -> moves, types
 *         pheno weather keys       -> concepts
 *         alphapedia ball labels   -> balls
 *         egg group labels         -> concepts
 *       The strings are re-derived here (same collector as the build) rather
 *       than trusted from the builder, so a stale table fails loudly.
 *   (b) structure: six categories, key-sorted, every value an object carrying
 *       `{ cn, source }`, `source` from the known provenance set, `cn` either
 *       a non-empty string or null (never an invented placeholder).
 *   (c) no Traditional-only characters leaked into any `cn` field - the table
 *       must be Simplified because the site only ever shows 中文（English）.
 *
 * Filled vs null counts are printed per category and every null entry is
 * listed; nulls are a deliberate English fallback, so they are reported, not
 * fatal (they are what data/cn-overrides.json is for).
 *
 * Exit code 0 = all blocking assertions passed, 1 = something failed.
 *
 * Node 18+, built-in modules only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const UPSTREAM = path.join(DATA, 'upstream');
const TERMS_FILE = path.join(DATA, 'cn-terms.json');

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

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const lower = (s) => String(s == null ? '' : s).toLowerCase();
const CN_CHARS = (s) => Array.from(s || '').filter((c) => /[㐀-鿿]/.test(c));

/** Same junk filter as the builder: `""` and `--` are placeholders, not terms. */
const isTerm = (s) => typeof s === 'string' && /[A-Za-z]/.test(s) && s.trim().length > 0;

/**
 * Traditional-only characters with their Simplified counterpart. A hit is
 * unambiguous: none of these are written this way in standard Simplified
 * Chinese. Deliberately a blacklist, not a converter - the same table
 * tools/verify-cn-data.js uses, so both scripts fail on the same glyphs.
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

/* -------------------------------------------------------------- vocabulary -- */

/** Recursive collector: every string under any object key named `wanted`. */
function deepCollect(node, wanted, out) {
  if (Array.isArray(node)) {
    for (const item of node) deepCollect(item, wanted, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === wanted) {
        if (Array.isArray(value)) value.forEach((v) => isTerm(v) && out.add(v));
        else if (isTerm(value)) out.add(value);
      } else {
        deepCollect(value, wanted, out);
      }
    }
  }
  return out;
}

/** Must stay in sync with collectVocabulary() in tools/build-cn-terms.js. */
function collectVocabulary() {
  const alpha = loadJson(path.join(UPSTREAM, 'alpha-spawn-data.json'));
  const swarm = loadJson(path.join(UPSTREAM, 'swarm-spawn-data.json'));
  const pheno = loadJson(path.join(UPSTREAM, 'pheno-spawn-data.json'));
  const alphapedia = loadJson(path.join(UPSTREAM, 'alphapedia-data.json'));
  const pokesearch = loadJson(path.join(UPSTREAM, 'pokesearch-data.json'));

  const hms = new Set();
  const moves = new Set();
  const abilities = new Set();
  const eggGroups = new Set();
  for (const doc of [alpha, swarm, pheno, alphapedia]) {
    deepCollect(doc, 'HMs', hms);
    deepCollect(doc, 'Moveset', moves);
    deepCollect(doc, 'Ability', abilities);
    deepCollect(doc, 'ability', abilities);
    deepCollect(doc, 'Egg Group', eggGroups);
    deepCollect(doc, 'egg_groups', eggGroups);
  }

  const weather = new Set();
  for (const loc of Object.values(pheno)) {
    if (!loc || typeof loc !== 'object') continue;
    for (const type of Object.keys(loc)) if (isTerm(type)) weather.add(type);
  }

  const balls = new Set();
  for (const row of Object.values(alphapedia)) {
    const list = ((row || {}).how || {}).balls || [];
    for (const ball of list) if (ball && isTerm(ball.ball)) balls.add(ball.ball);
  }

  const types = new Set();
  if (Array.isArray(pokesearch)) {
    for (const row of pokesearch) {
      for (const ability of row.abilities || []) if (ability && isTerm(ability.name)) abilities.add(ability.name);
      for (const move of row.moves || []) if (move && isTerm(move.name)) moves.add(move.name);
      for (const type of row.types || []) if (isTerm(type)) types.add(type);
      for (const group of row.egg_groups || []) if (isTerm(group)) eggGroups.add(group);
    }
  }

  const sorted = (set) => [...set].sort();
  return {
    hms: sorted(hms),
    moves: sorted(moves),
    abilities: sorted(abilities),
    types: sorted(types),
    balls: sorted(balls),
    weather: sorted(weather),
    eggGroups: sorted(eggGroups),
  };
}

/* ------------------------------------------------------------- main checks -- */

say(`verify-cn-terms  (${CONSOLE_IS_UTF8 ? 'utf-8 console' : 'ascii-escaped console; files are utf-8'})`);

if (!fs.existsSync(TERMS_FILE)) {
  say('FAIL  data/cn-terms.json is missing - run: node tools/build-cn-terms.js');
  process.exitCode = 1;
} else {
  const terms = loadJson(TERMS_FILE);
  const vocab = collectVocabulary();

  say('');
  say('--- (0) structure ---');
  const CATEGORIES = ['moves', 'abilities', 'types', 'hms', 'balls', 'concepts'];
  const ALLOWED_SOURCES = new Set(['pokeapi', 'manual', 'alphapedia-i18n', 'no-match', 'cache-miss']);
  check('cn-terms.json is a plain object', !!terms && !Array.isArray(terms));
  check(
    `exactly the six categories (${CATEGORIES.join(', ')})`,
    CATEGORIES.every((c) => terms[c] && typeof terms[c] === 'object') &&
      Object.keys(terms).length === CATEGORIES.length,
    Object.keys(terms).join(', ')
  );

  const badShape = [];
  const badSource = [];
  const unsorted = [];
  const emptyCn = [];
  for (const cat of CATEGORIES) {
    const map = terms[cat] || {};
    const keys = Object.keys(map);
    if (!keys.every((k, i) => i === 0 || keys[i - 1] <= k)) unsorted.push(cat);
    for (const key of keys) {
      const entry = map[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        badShape.push(`${cat}:${key}`);
        continue;
      }
      if (!has(entry, 'cn') || !has(entry, 'source')) badShape.push(`${cat}:${key} lacks cn/source`);
      if (!ALLOWED_SOURCES.has(entry.source)) badSource.push(`${cat}:${key} source=${entry.source}`);
      if (entry.cn !== null && typeof entry.cn !== 'string') badShape.push(`${cat}:${key} cn=${entry.cn}`);
      if (typeof entry.cn === 'string' && !entry.cn.trim()) emptyCn.push(`${cat}:${key}`);
    }
  }
  check('every value is an object carrying cn + source', badShape.length === 0,
    badShape.length ? badShape.slice(0, 10).join(', ') : 'ok');
  check('every cn is null or a non-empty string', emptyCn.length === 0, emptyCn.join(', ') || 'ok');
  check('every source is a known provenance', badSource.length === 0,
    badSource.length ? badSource.slice(0, 10).join(', ') : [...ALLOWED_SOURCES].join('|'));
  check('every category is key-sorted for stable diffs', unsorted.length === 0, unsorted.join(', ') || 'ok');

  /* (a) coverage: data strings -> table entries ---------------------------- */

  say('');
  say('--- (a) coverage of the upstream vocabulary ---');

  /** Case-insensitive lookup, mirroring src/dict.js's `termsIndex`. */
  function lookup(cat, value) {
    const map = terms[cat] || {};
    if (has(map, value)) return map[value];
    const want = lower(value);
    const hit = Object.keys(map).find((k) => lower(k) === want);
    if (hit) return map[hit];
    if (cat !== 'concepts') return undefined;
    // Egg-group labels arrive in three spellings for the same thing (alphapedia
    // `Watera`, pokesearch `water a`, alpha/swarm `Water A`) and the builder
    // merges them onto one canonical key, so fold whitespace/case here too.
    const fold = (s) => lower(s).replace(/[^a-z0-9]/g, '');
    const folded = fold(value);
    const merged = Object.keys(map).find((k) => fold(k) === folded);
    return merged ? map[merged] : undefined;
  }

  const coverageSets = [
    { cat: 'hms', label: 'HM labels (alpha/swarm/pheno)', values: vocab.hms },
    { cat: 'moves', label: 'move names (alpha/swarm Moveset + pokesearch)', values: vocab.moves },
    { cat: 'abilities', label: 'ability names (spawn data + alphapedia + pokesearch)', values: vocab.abilities },
    { cat: 'types', label: 'type names (pokesearch, uppercase)', values: vocab.types },
    { cat: 'balls', label: 'ball labels (alphapedia how.balls)', values: vocab.balls },
    { cat: 'concepts', label: 'pheno weather keys', values: vocab.weather },
    { cat: 'concepts', label: 'egg group labels', values: vocab.eggGroups },
  ];

  const absentByCat = {};
  for (const set of coverageSets) {
    const absent = set.values.filter((v) => lookup(set.cat, v) === undefined);
    absentByCat[set.cat] = absent;
    check(`every ${set.label} string has an entry (${set.values.length} distinct)`,
      absent.length === 0, absent.length ? `absent: ${absent.slice(0, 12).join(', ')}${absent.length > 12 ? ' ...' : ''}` : 'all present');
  }

  // Types are keyed exactly as our data writes them (uppercase `GRASS`).
  const typeKeyAbsent = vocab.types.filter((t) => !has(terms.types || {}, t));
  check('type keys keep the uppercase spelling used by the data', typeKeyAbsent.length === 0,
    typeKeyAbsent.length ? `absent as written: ${typeKeyAbsent.join(', ')}` : vocab.types.slice(0, 4).join(', ') + ' ...');
  const canonicalTypes = ['NORMAL', 'FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST',
    'STEEL', 'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'PSYCHIC', 'ICE', 'DRAGON', 'DARK', 'FAIRY'];
  const missingCanonical = canonicalTypes.filter((t) => lookup('types', t) === undefined);
  check('all 18 canonical types are present', missingCanonical.length === 0,
    missingCanonical.length ? missingCanonical.join(', ') : '18/18');

  // HM strings are move names: the two tables must agree where they overlap.
  const hmDrift = vocab.hms.filter((h) => {
    const hm = lookup('hms', h);
    const mv = lookup('moves', h);
    return hm && mv && hm.cn && mv.cn && hm.cn !== mv.cn;
  });
  check('hm entries agree with the move entry of the same name', hmDrift.length === 0,
    hmDrift.length ? hmDrift.map((h) => `${h}: ${lookup('hms', h).cn} vs ${lookup('moves', h).cn}`).join(' | ') : 'ok');

  // Bare ball genera must resolve too: refdata.js strips the year before lookup.
  const ballGenera = [...new Set(vocab.balls.map((b) => b.replace(/\s+\S+$/, '').trim()))].filter(Boolean);
  const genusAbsent = ballGenera.filter((g) => lookup('balls', g) === undefined);
  check(`bare ball genera resolve (${ballGenera.join(', ')})`, genusAbsent.length === 0,
    genusAbsent.length ? `absent: ${genusAbsent.join(', ')}` : 'ok');

  /* (b) no Traditional characters ------------------------------------------ */

  say('');
  say('--- (b) Simplified-Chinese check ---');
  const tradHits = [];
  for (const cat of CATEGORIES) {
    for (const key of Object.keys(terms[cat] || {})) {
      const entry = terms[cat][key];
      for (const hit of findTraditional(entry && entry.cn)) {
        tradHits.push(`${cat}:${key} ${hit.ch}->${hit.simp}`);
      }
    }
  }
  check('no Traditional-Chinese characters in any cn field',
    tradHits.length === 0, tradHits.length ? tradHits.slice(0, 12).join(' | ') : 'clean');

  /* coverage reports ------------------------------------------------------- */

  const reports = {};
  for (const cat of CATEGORIES) {
    const map = terms[cat] || {};
    const keys = Object.keys(map);
    const entries = keys.map((k) => ({ key: `${cat}:${k}`, cn: map[k] && map[k].cn }));
    const filled = entries.filter((e) => typeof e.cn === 'string' && e.cn.trim());
    const nulls = entries.filter((e) => !filled.includes(e));
    reports[cat] = { total: keys.length, filled: filled.length, nulls: nulls.map((n) => n.key) };
  }

  say('');
  say('=== coverage per category ===');
  for (const cat of CATEGORIES) {
    const r = reports[cat];
    say(`  ${cat.padEnd(10)}: ${r.filled}/${r.total} filled, ${r.nulls.length} null`);
    if (r.nulls.length) say(`    null entries (${r.nulls.length}): ${r.nulls.join(', ')}`);
  }

  // Nulls are allowed by design (the UI shows 中文（English）and degrades to
  // English), but they must never be silent: warn and list them above.
  const nullTotal = CATEGORIES.reduce((n, c) => n + reports[c].nulls.length, 0);
  if (nullTotal) warn(`${nullTotal} null cn entry/entries kept as English fallback (fill via data/cn-overrides.json)`);
  for (const cat of CATEGORIES) {
    if (absentByCat[cat] && absentByCat[cat].length) warn(`${cat}: ${absentByCat[cat].length} data string(s) have no entry at all`);
  }

  say('');
  if (failures.length) {
    say(`RESULT: FAIL (${failures.length} assertion(s))`);
    for (const f of failures) say(`  - ${f}`);
    process.exitCode = 1;
  } else {
    say('RESULT: PASS');
    say(`  ${CATEGORIES.map((c) => `${c} ${reports[c].filled}/${reports[c].total}`).join(', ')}`);
    if (warnings.length) say(`  ${warnings.length} warning(s) - see above`);
    process.exitCode = 0;
  }
}
