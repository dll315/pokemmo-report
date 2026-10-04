#!/usr/bin/env node
/**
 * tools/build-cn-data.js
 *
 * Builds the two Chinese translation tables used by the PokeMMO spawn tracker:
 *
 *   data/cn-species.json    English species name -> { cn, natdex, [variant] }
 *   data/cn-locations.json  { locations: { English place name -> { cn, kind } }, regions: {...} }
 *
 * Species data is fetched live from PokeAPI v2 (`pokemon-species/{natdex}`, the
 * `names[]` array, language `zh-hans`, falling back to `zh-hant`). Every raw
 * response slice is cached to `tools/.cn-cache/<natdex>.json` so re-runs are
 * cheap and byte-for-byte idempotent.
 *
 * Location data is NOT fetched at build time. `Route N` is handled
 * programmatically (`N号道路`); everything else comes from CN_PLACE below, a
 * curated table of the official Simplified Chinese place names as used by the
 * Pokémon games (心金/魂银, 黑/白, 欧米伽红宝石/蓝宝石, 钻石/珍珠/白金 era names).
 * Anything not listed there is emitted with `cn: null` instead of an invented
 * literal translation.
 *
 * Node 20+, built-in modules only. No npm dependencies.
 *
 * Usage:
 *   node tools/build-cn-data.js                 build both tables (network for species)
 *   node tools/build-cn-data.js --offline       never hit the network, cache only
 *   node tools/build-cn-data.js --refresh       ignore the cache, re-fetch everything
 *   node tools/build-cn-data.js --species-only  |  --locations-only
 *
 * Console safety: the JSON files are always written as UTF-8. Stdout is
 * UTF-8 when the environment advertises it, otherwise non-ASCII characters are
 * printed as \uXXXX escapes so a GBK codepage console never sees an
 * un-encodable byte.
 */
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

/* ------------------------------------------------------------------ paths -- */

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPSTREAM_DIR = path.join(DATA_DIR, 'upstream');
const CACHE_DIR = path.join(__dirname, '.cn-cache');

const OUT_SPECIES = path.join(DATA_DIR, 'cn-species.json');
const OUT_LOCATIONS = path.join(DATA_DIR, 'cn-locations.json');

const F_POKESEARCH = path.join(UPSTREAM_DIR, 'pokesearch-data.json');
const F_NATDEX_MAP = path.join(UPSTREAM_DIR, 'pokemon-natdex-map.json');
const F_UNIVERSE = path.join(DATA_DIR, 'species-universe.json');
const F_SPAWN_FILES = ['alpha', 'swarm', 'pheno'].map((n) =>
  path.join(UPSTREAM_DIR, `${n}-spawn-data.json`)
);

/* -------------------------------------------------------------- tunables -- */

const API_URL = (natdex) => `https://pokeapi.co/api/v2/pokemon-species/${natdex}`;
const CONCURRENCY = 10;      // max simultaneous in-flight requests
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;      // per request, then give up on that species
const BACKOFF_BASE_MS = 500; // 500ms, 1000ms, 2000ms (+ jitter)

/* ---------------------------------------------------------------- console -- */

try {
  if (typeof process.stdout.setDefaultEncoding === 'function') {
    process.stdout.setDefaultEncoding('utf8');
  }
} catch {
  /* older runtimes: fall through to the escaper below */
}

const CONSOLE_IS_UTF8 = /utf-?8/i.test(
  `${process.env.LANG || ''}${process.env.LC_ALL || ''}${process.env.LC_CTYPE || ''}${process.env.QODER_CONSOLE_UTF8 || ''}`
);

/** Never emit a byte the active console codepage may not be able to encode. */
function asciiSafe(str) {
  let out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    out += c < 128 ? ch : '\\u' + c.toString(16).padStart(4, '0');
  }
  return out;
}

function say(line) {
  const text = String(line);
  process.stdout.write((CONSOLE_IS_UTF8 ? text : asciiSafe(text)) + '\n');
}

/* ------------------------------------------------------------------ utils -- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback === undefined) throw new Error(`Cannot read ${file}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  say(`wrote ${path.relative(ROOT, file)} (${Object.keys(Array.isArray(value) ? value : value).length} top-level keys)`);
}

/** Sort keys so a regenerated file never produces noise in a diff. */
function sortObject(source) {
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

/* ----------------------------------------------------------------- http -- */

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': 'pokemmo-spawns-cn-builder/1.0', accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

/** GET + parse with bounded retries and exponential backoff. */
async function fetchJsonWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await rawGet(url);
      if (res.status === 200) {
        try {
          return JSON.parse(res.body);
        } catch {
          throw new Error('invalid JSON body');
        }
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
  throw lastError || new Error('request failed');
}

/** Fixed-size promise pool; keeps going after individual failures. */
async function runPool(items, size, worker) {
  let cursor = 0;
  const errors = [];
  async function lane() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (err) {
        errors.push(err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane));
  return errors;
}

/* -------------------------------------------------------------- species -- */

/** Pick the Chinese label, preferring Simplified, falling back to Traditional. */
function pickChineseName(names) {
  const forLang = (lang) => {
    const hit = (names || []).find(
      (n) => n && n.language && n.language.name === lang && typeof n.name === 'string' && n.name.trim()
    );
    return hit ? hit.name.trim() : null;
  };
  const hans = forLang('zh-hans');
  if (hans) return { cn: hans, variant: undefined };
  const hant = forLang('zh-hant');
  if (hant) return { cn: hant, variant: 'hant' };
  return { cn: null, variant: 'none' };
}

function cachePathFor(natdex) {
  return path.join(CACHE_DIR, `${natdex}.json`);
}

function readCache(natdex) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePathFor(natdex), 'utf8'));
    if (raw && Array.isArray(raw.names)) return raw;
  } catch {
    /* miss */
  }
  return null;
}

function writeCache(entry) {
  fs.writeFileSync(cachePathFor(entry.id), JSON.stringify(entry, null, 2) + '\n', 'utf8');
}

async function buildSpecies(opts) {
  const pokesearch = readJson(F_POKESEARCH);
  const natdexMap = readJson(F_NATDEX_MAP, {});
  if (!Array.isArray(pokesearch) || !pokesearch.length) {
    throw new Error('pokesearch-data.json is empty or not an array');
  }

  // 649 entries, id === National Dex number. De-dupe defensively.
  const species = [];
  const seenId = new Set();
  for (const row of pokesearch) {
    if (!row || typeof row.id !== 'number' || typeof row.name !== 'string') continue;
    if (seenId.has(row.id)) continue;
    seenId.add(row.id);
    if (!opts.quiet) {
      const slug = row.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const mapped = natdexMap[slug];
      if (mapped !== undefined && mapped !== row.id) {
        say(`warn: ${row.name} natdex mismatch (pokesearch ${row.id} vs natdex-map ${mapped})`);
      }
    }
    species.push({ name: row.name, natdex: row.id });
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const stats = { total: species.length, cacheHits: 0, fetched: 0, failed: 0, hans: 0, hant: 0, none: 0 };
  const results = {};
  const failures = [];

  const errors = await runPool(species, CONCURRENCY, async (row) => {
    let cached = opts.refresh ? null : readCache(row.natdex);
    if (cached) {
      stats.cacheHits += 1;
    } else if (opts.offline) {
      cached = null;
      stats.failed += 1;
      failures.push(`${row.name} (#${row.natdex}) [offline, no cache]`);
    } else {
      let json;
      let lastError;
      for (let tryNo = 1; tryNo <= MAX_ATTEMPTS; tryNo += 1) {
        try {
          json = await fetchJsonWithRetry(API_URL(row.natdex));
          break;
        } catch (err) {
          lastError = err;
          if (tryNo < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (tryNo - 1));
        }
      }
      if (!json) {
        stats.failed += 1;
        failures.push(`${row.name} (#${row.natdex}) [${lastError.message}]`);
      } else {
        cached = {
          id: row.natdex,
          apiName: json.name,
          fetchedAt: new Date().toISOString(),
          // Raw slice of the upstream response that the translation is derived
          // from; keeping `names` verbatim makes rebuilds offline and exact.
          names: json.names || [],
        };
        writeCache(cached);
        stats.fetched += 1;
      }
    }

    const picked = cached ? pickChineseName(cached.names) : { cn: null, variant: 'none' };
    if (picked.variant === 'hant') stats.hant += 1;
    else if (picked.variant === 'none') stats.none += 1;
    else stats.hans += 1;

    const entry = { cn: picked.cn, natdex: row.natdex };
    if (picked.variant && picked.variant !== 'hans') entry.variant = picked.variant;
    results[row.name] = entry;
  });

  if (errors.length) say(`warn: ${errors.length} unexpected pool errors`);

  writeJson(OUT_SPECIES, sortObject(results));

  say('');
  say('--- species (cn-species.json) ---');
  say(`total species        : ${stats.total}`);
  say(`zh-hans filled       : ${stats.hans}`);
  say(`zh-hant fallback     : ${stats.hant}`);
  say(`no chinese / failed  : ${stats.none}`);
  say(`network fetches      : ${stats.fetched}  (cache hits: ${stats.cacheHits})`);
  say(`fetch failures       : ${stats.failed}`);
  if (failures.length) say(`failed list          : ${failures.join(', ')}`);

  // Every name in the alpha/swarm universe must be translatable.
  const universe = readJson(F_UNIVERSE, []);
  const gaps = universe.filter((n) => !results[n] || !results[n].cn);
  if (gaps.length) {
    say(`universe gaps        : ${gaps.length} -> ${gaps.join(', ')}`);
  } else {
    say('universe gaps        : 0 (all species-universe.json names have a cn name)');
  }

  return stats.failed === 0 && gaps.length === 0;
}

/* ------------------------------------------------------------- locations -- */

/**
 * Official Simplified Chinese place names.
 *
 * Provenance: the game's own Simplified Chinese localisation (心金/魂银, 黑/白,
 * 欧米伽红宝石/蓝宝石, 钻石/珍珠/白金 era), cross-checked against the Chinese
 * Pokémon wiki's canonical article titles. Values are written in Simplified
 * Chinese even where a source page title happens to use Traditional forms.
 *
 * Keys are the exact English strings used by the upstream spawn data.
 * `null` means "no confident official name" - the UI should then show English.
 */
const CN_PLACE = {
  'Abandoned Ship': '弃船',
  'Abundant Shrine': '丰饶之祠',
  'Acuity Lakefront': '睿智湖畔',
  'Aqua Hideout': '海洋队基地',
  'Artisan Cave': '工匠之穴',
  'Battle Frontier': '对战开拓区',
  'Bell Tower': '铃铛塔',
  'Bellchime Trail': '铃音小道',
  'Berry Forest': '树果森林',
  'Bond Bridge': '牵绊桥',
  'Burned Tower': '烧焦塔',
  'Canyon Entrance': '溪谷入口',
  'Cape Brink': '边缘海岬',
  'Celestial Tower': '天堂之塔',
  'Cerulean Cave': '华蓝洞窟',
  "Challenger's Cave": '修行岩屋',
  'Chargestone Cave': '电气石洞穴',
  'Cliff Cave': '断崖洞窟',
  'Cliff Edge Gate': '断崖入口',
  'Cold Storage': '冷冻仓库',
  'Dark Cave': '黑暗洞穴',
  'Desert Resort': '荒野名胜区',
  'Desert Underpass': '沙漠的地下道',
  "Diglett's Cave": '地鼠洞穴',
  "Dragon's Den": '龙穴',
  'Dragonspiral Tower': '龙螺旋之塔',
  'Dreamyard': '梦的遗址',
  'Driftveil City': '帆巴市',
  'Driftveil Drawbridge': '帆巴吊桥',
  'Eterna Forest': '百代森林',
  'Ever Grande City': '彩悠市',
  'Fiery Path': '烈焰小径',
  'Five Island': '第五岛',
  'Five Isle Meadow': '第五岛空地',
  'Floaroma Meadow': '花苑花田',
  'Four Island': '第四岛',
  'Fuego Ironworks': '多多罗钢铁厂',
  'Giant Chasm': '巨人洞窟',
  'Granite Cave': '石之洞窟',
  'Great Marsh': '大湿地',
  'Green Path': '绿之步道',
  'Guidance Chamber': null, // no confident official name (see report)
  'Ice Path': '冰雪小径',
  'Icefall Cave': '冻瀑洞窟',
  'Icirrus City': '雪花市',
  'Ilex Forest': '栎树林',
  'Iron Island': '钢铁岛',
  'Jagged Pass': '凹凸山道',
  'Kindle Road': '热气之路',
  'Lake Acuity': '睿智湖',
  'Lake of Rage': '愤怒之湖',
  'Lake Valor': '立志湖',
  'Lake Verity': '心齐湖',
  'Lighthouse': '正辉的灯塔',
  'Lost Cave': '不归之穴',
  'Lost Tower': '迷失塔',
  'Lostlorn Forest': '迷幻森林',
  'Magma Hideout': '熔岩队基地',
  'Maniac Tunnel': '遗迹迷隧道',
  'Marvelous Bridge': '奇幻桥',
  'Memorial Pillar': '回忆之塔',
  'Meteor Falls': '流星瀑布',
  'Mirage Tower': '幻影之塔',
  'Mistralton Cave': '吹寄洞穴',
  'Moor of Icirrus': '雪花湿地',
  'Mt. Chimney': '烟囱山',
  'Mt. Coronet': '天冠山',
  'Mt. Ember': '灯火山',
  'Mt. Moon': '月见山',
  'Mt. Mortar': '擂钵山',
  'Mt. Pyre': '送神山',
  'Mt. Silver Cave': '白银山',
  'National Park': '自然公园',
  'New Mauville': '新紫堇',
  'Old Chateau': '森之洋馆',
  'One Island': '第一岛',
  'Oreburgh Gate': '黑金闸口',
  'Oreburgh Mine': '黑金炭坑',
  'P2 Laboratory': 'Ｐ２实验室',
  'Pastoria City': '野原市',
  'Pattern Bush': '标志之林',
  'Petalburg Woods': '橙华森林',
  'Pinwheel Forest': '矢车森林',
  'Pokemon Mansion': '宝可梦屋',
  'Pokemon Tower': '宝可梦塔',
  'Power Plant': '无人发电厂',
  'Ravaged Path': '荒芜小道',
  'Relic Castle': '古代城',
  'Resort Gorgeous': '豪华度假区',
  'Rock Tunnel': '岩山隧道',
  'Ruin Valley': '遗迹山谷',
  'Ruins of Alph': '阿露福遗迹',
  'Rusturf Tunnel': '卡绿隧道',
  'Safari Zone': '狩猎地带',
  'Scorched Slab': '天旱石窟',
  'Seafloor Cavern': '海底洞窟',
  'Seafoam Islands': '双子岛',
  'Sendoff Spring': '送行之泉',
  'Sevault Canyon': '七宝溪谷',
  'Seven Island': '第七岛',
  'Shoal Cave': '浅滩洞穴',
  'Six Island': '第六岛',
  'Sky Pillar': '天空之柱',
  'Slowpoke Well': '呆呆兽之井',
  'Snowpoint Temple': '雪峰神殿',
  'Sootopolis City': '琉璃市',
  'Spear Pillar': '枪之柱',
  'Sprout Tower': '喇叭芽之塔',
  'Stark Mountain': '严酷山',
  'Striaton City': '三曜市',
  'Tanoby Ruins': '阿斯卡纳遗迹',
  'Team Rocket HQ': '火箭队基地',
  'Three Island': '第三岛',
  'Tohjo Falls': '都城瀑布',
  'Trainer Tower': '训练家塔',
  'Treasure Beach': '宝物海滩',
  'Trophy Garden': '自豪的后院',
  'Turnback Cave': '归途洞窟',
  'Twist Mountain': '罗斯山',
  'Two Island': '第二岛',
  'Undella Bay': '涟漪湾',
  'Undella Town': '涟漪镇',
  'Underwater': '水中',
  'Union Cave': '互连洞',
  'Valley Windworks': '山谷发电厂',
  'Valor Lakefront': '立志湖畔',
  'Vermilion City': '枯叶市',
  'Victory Road': '冠军之路',
  'Village Bridge': '村庄桥',
  'Viridian Forest': '常青森林',
  'Water Labyrinth': '水之迷宫',
  'Water Path': '水之步道',
  'Wayward Cave': '迷幻洞窟',
  'Wellspring Cave': '泉源洞穴',
  'Whirl Islands': '漩涡岛',
};

/** Regions seen in alpha/swarm top-level keys. */
const CN_REGION = {
  Hoenn: '丰缘地区',
  Johto: '城都地区',
  Kanto: '关都地区',
  Sinnoh: '神奥地区',
  Unova: '合众地区',
};

/** Sub-area qualifiers, translated and appended in parentheses. */
const CN_QUALIFIER = {
  Cave: '洞窟',
  Entrance: '入口',
  Forest: '森林',
  Inner: '内部',
  Outer: '外部',
};

/** Settlements and non-specific areas are `other`; wild-area landmarks are `special`. */
const OTHER_KIND = new Set([
  'Driftveil City',
  'Ever Grande City',
  'Icirrus City',
  'Pastoria City',
  'Sootopolis City',
  'Striaton City',
  'Undella Town',
  'Vermilion City',
  'Underwater',
]);

const ROUTE_RE = /^Route (\d+)$/;
const QUALIFIED_RE = /^(.*?) \(([^)]+)\)$/;

function classifyKind(name) {
  if (ROUTE_RE.test(name)) return 'route';
  if (OTHER_KIND.has(name)) return 'other';
  return 'special';
}

/** Case-insensitive lookup so `Moor Of Icirrus` matches `Moor of Icirrus`. */
function lookupPlace(name) {
  if (Object.prototype.hasOwnProperty.call(CN_PLACE, name)) {
    return { cn: CN_PLACE[name], source: 'table' };
  }
  const folded = name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const key of Object.keys(CN_PLACE)) {
    if (key.toLowerCase().replace(/\s+/g, ' ').trim() === folded) {
      return { cn: CN_PLACE[key], source: 'case-fold' };
    }
  }
  const qualified = name.match(QUALIFIED_RE);
  if (qualified) {
    const base = qualified[1].trim();
    const qual = qualified[2].trim();
    const baseCn = lookupPlace(base).cn;
    const qualCn = CN_QUALIFIER[qual];
    if (typeof baseCn === 'string' && baseCn && qualCn) {
      return { cn: `${baseCn}（${qualCn}）`, source: 'composed' };
    }
  }
  return { cn: null, source: 'unknown' };
}

/**
 * Location keys are region-keyed in alpha/swarm (`data[region][location]`) but
 * flat in pheno (`data[location]`). Take the union.
 */
function collectLocationKeys() {
  const keys = new Set();
  for (const file of F_SPAWN_FILES) {
    const data = readJson(file, {});
    for (const top of Object.keys(data)) {
      const value = data[top];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const looksLikeRegion = !value.name && Object.values(value).every((v) => v && typeof v === 'object');
      if (looksLikeRegion && CN_REGION[top]) {
        for (const loc of Object.keys(value)) keys.add(loc);
      } else {
        keys.add(top);
      }
    }
  }
  return [...keys].sort();
}

function buildLocations() {
  const names = collectLocationKeys();
  const out = {};
  const stats = { total: names.length, route: 0, table: 0, composed: 0, caseFold: 0, null: 0 };
  const unresolved = [];
  const nulled = [];

  for (const name of names) {
    const route = name.match(ROUTE_RE);
    let cn;
    let source;
    if (route) {
      cn = `${route[1]}号道路`;
      source = 'route';
      stats.route += 1;
    } else {
      const found = lookupPlace(name);
      cn = found.cn;
      source = found.source;
      if (source === 'table') stats.table += 1;
      else if (source === 'composed') stats.composed += 1;
      else if (source === 'case-fold') stats.caseFold += 1;
      else stats.null += 1;
    }
    if (cn === null) (source === 'unknown' ? unresolved : nulled).push(name);
    out[name] = { cn, kind: classifyKind(name) };
  }

  writeJson(OUT_LOCATIONS, { locations: sortObject(out), regions: sortObject(CN_REGION) });

  say('');
  say('--- locations (cn-locations.json) ---');
  say(`total location keys : ${stats.total}`);
  say(`Route N -> N号道路  : ${stats.route}`);
  say(`curated table hits  : ${stats.table}`);
  say(`composed qualifiers : ${stats.composed} (Giant Chasm / Pinwheel Forest family)`);
  say(`case-folded dupes   : ${stats.caseFold} (e.g. Moor Of Icirrus)`);
  say(`explicit null       : ${nulled.length}`);
  say(`no data at all      : ${stats.null}`);
  if (nulled.length) say(`explicitly nulled   : ${nulled.join(', ')}`);
  if (unresolved.length) say(`unmatched (add to CN_PLACE): ${unresolved.join(', ')}`);

  return unresolved.length === 0;
}

/* ------------------------------------------------------------------- cli -- */

(async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    offline: argv.includes('--offline'),
    refresh: argv.includes('--refresh'),
    speciesOnly: argv.includes('--species-only'),
    locationsOnly: argv.includes('--locations-only'),
    quiet: argv.includes('--quiet'),
  };

  let ok = true;
  if (!opts.locationsOnly) ok = (await buildSpecies(opts)) && ok;
  if (!opts.speciesOnly) ok = buildLocations() && ok;

  if (!CONSOLE_IS_UTF8) {
    say('note: non-UTF-8 console detected; Chinese output above is \\uXXXX escaped. Files are UTF-8.');
  }
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  say(`FATAL ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
