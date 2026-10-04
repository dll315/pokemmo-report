#!/usr/bin/env node
/**
 * tools/build-cn-terms.js
 *
 * Builds the Chinese terminology table used by the PokeMMO spawn tracker:
 *
 *   data/cn-terms.json   { moves, abilities, types, hms, balls, concepts }
 *
 * Every category value is an object `{ cn, source, [note] }` so provenance
 * survives a rebuild. Keys are the exact strings used by the upstream data
 * (`GRASS` for types, `Crabhammer` / `SolarBeam` for moves, `Ultra 2025` for
 * event balls) and every map is key-sorted so a rebuild never produces diff
 * noise.
 *
 * Where the vocabulary comes from (see collectVocabulary() below - the lists
 * are derived from the data files, never hand-picked):
 *   - data/upstream/alpha-spawn-data.json      HMs, Moveset, Ability, Egg Group
 *   - data/upstream/swarm-spawn-data.json      HMs, Moveset, Ability, Egg Group
 *   - data/upstream/pheno-spawn-data.json      HMs, weather keys, Egg Group
 *   - data/upstream/alphapedia-data.json       ability, Egg Group, ball labels
 *   - data/upstream/pokesearch-data.json       moves, abilities, types, egg groups
 *
 * Where the Chinese comes from:
 *   moves / abilities / types  PokeAPI v2 `names[]`, language `zh-hans` ONLY
 *                              (`zh-hant` is deliberately ignored; a term that
 *                              only exists in Traditional form is emitted as
 *                              null instead of leaking Traditional glyphs).
 *                              Resolution is: display name -> slug candidate ->
 *                              fetched detail -> round-trip check that the API's
 *                              `en` name (or slug) normalizes to the same string.
 *                              A name that cannot be round-tripped is null.
 *   hms                        resolved through the move table (HM items are
 *                              named after their move). `MANUAL_HM` is the
 *                              documented escape hatch for HM labels the move
 *                              table cannot answer; those get source `manual`.
 *   balls                      `MANUAL_BALL_GENUS` hand table (PokeAPI does not
 *                              name event balls like "Ultra 2025"). The genus is
 *                              translated, the trailing token is kept verbatim,
 *                              source is `manual`, and each genus is
 *                              cross-checked against PokeAPI `item/{slug}`
 *                              zh-hans so a typo cannot survive a rebuild.
 *   concepts                   the upstream site's own Simplified Chinese
 *                              catalog (data/upstream/i18n-zh.json, fetched from
 *                              alpha.pokemmotools.org when missing) - verbatim,
 *                              plus `Pheno` derived from its "<weather> Pheno"
 *                              compounds. Egg group labels the catalog does not
 *                              ship are emitted as null, not invented.
 *
 * Caching / cost: every raw API slice is cached under tools/.terms-cache/, so a
 * re-run is network-free. `--offline` refuses to touch the network at all and
 * answers from the cache only. Requests run through a pool of CONCURRENCY (10),
 * each with a REQUEST_TIMEOUT_MS (15s) deadline and MAX_ATTEMPTS (3) tries with
 * exponential backoff; one dead entry never aborts the build.
 *
 * Node 18+, built-in modules only. No npm dependencies.
 *
 * Usage:
 *   node tools/build-cn-terms.js              build (network for cache misses)
 *   node tools/build-cn-terms.js --offline    cache only, never the network
 *   node tools/build-cn-terms.js --refresh    ignore the cache, re-fetch
 *
 * Console safety: the JSON file is always written as UTF-8. Stdout is UTF-8
 * only when the environment advertises it; otherwise non-ASCII is printed as
 * \uXXXX escapes so a GBK codepage console never sees an un-encodable byte.
 */
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

/* ------------------------------------------------------------------ paths -- */

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPSTREAM_DIR = path.join(DATA_DIR, 'upstream');
const CACHE_DIR = path.join(__dirname, '.terms-cache');

const OUT_FILE = path.join(DATA_DIR, 'cn-terms.json');
const I18N_FILE = path.join(UPSTREAM_DIR, 'i18n-zh.json');

const F_ALPHA = path.join(UPSTREAM_DIR, 'alpha-spawn-data.json');
const F_SWARM = path.join(UPSTREAM_DIR, 'swarm-spawn-data.json');
const F_PHENO = path.join(UPSTREAM_DIR, 'pheno-spawn-data.json');
const F_ALPHAPEDIA = path.join(UPSTREAM_DIR, 'alphapedia-data.json');
const F_POKESEARCH = path.join(UPSTREAM_DIR, 'pokesearch-data.json');

/* -------------------------------------------------------------- tunables -- */

const API = (resource, idOrSlug) => `https://pokeapi.co/api/v2/${resource}/${idOrSlug}`;
const I18N_URL = 'https://alpha.pokemmotools.org/static/translations/zh/extra-zh.json';

const CONCURRENCY = 10;      // max simultaneous in-flight requests
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;      // per request, then give up on that term
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
  const size = fs.statSync(file).size;
  say(`wrote ${path.relative(ROOT, file)} (${size} bytes)`);
}

/** Sort keys so a regenerated file never produces noise in a diff. */
function sortObject(source) {
  const out = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

/**
 * Comparison key for a display string: lowercase, accents folded to ASCII
 * (e-acute -> e), and every space / hyphen / apostrophe / punctuation dropped,
 * so `SolarBeam`, `Solar Beam` and `solar-beam` all collapse to `solarbeam`.
 */
function norm(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** A real term contains letters; `""` and `--` are upstream placeholder noise. */
const isTerm = (s) => typeof s === 'string' && /[A-Za-z]/.test(s) && s.trim().length > 0;

/** Own-property test, so data-derived keys can never hit Object.prototype. */
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/* ------------------------------------------------------------------- http -- */

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': 'pokemmo-spawns-cn-terms/1.0', accept: 'application/json' } },
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

/** GET + parse with bounded retries and exponential backoff; null on failure. */
async function fetchJson(url) {
  let lastError = 'request failed';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await rawGet(url);
      if (res.status === 200) {
        try {
          return { json: JSON.parse(res.body) };
        } catch {
          return { error: 'invalid JSON body' };
        }
      }
      if (res.status === 404) return { error: 'HTTP 404' };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
  return { error: lastError };
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

/* ------------------------------------------------------------------ cache -- */

/**
 * The cache stores the raw `names[]` slice of every response (plus the list
 * endpoints), never the final translation, so a rebuild is offline, exact and
 * auditable. Layout:
 *   tools/.terms-cache/lists/{move,ability,type}-list.json
 *   tools/.terms-cache/{moves,abilities,types,items}/<id or slug>.json
 *   tools/.terms-cache/i18n-zh.json
 */
function cachePath(group, name) {
  return path.join(CACHE_DIR, group, `${name}.json`);
}

function readCache(group, name, valid) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(group, name), 'utf8'));
    return valid(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(group, name, value) {
  const file = cachePath(group, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const hasNames = (r) => !!r && Array.isArray(r.names);

/**
 * Fetch one PokeAPI resource slice, cache it, return `{ names, slug, id }` or
 * null when it is unavailable (offline + no cache, or every retry failed).
 */
async function pokeResource(group, resource, idOrSlug, cacheName, opts, stats) {
  const key = String(cacheName).replace(/[^A-Za-z0-9._-]/g, '_');
  let hit = opts.refresh ? null : readCache(group, key, hasNames);
  if (hit) {
    stats.cacheHits += 1;
    return hit;
  }
  if (opts.offline) {
    stats.cacheMisses += 1;
    return null;
  }
  const res = await fetchJson(API(resource, idOrSlug));
  if (!res.json) {
    stats.failed += 1;
    stats.errors.push(`${resource}/${idOrSlug}: ${res.error}`);
    return null;
  }
  hit = {
    id: res.json.id,
    slug: res.json.name,
    fetchedAt: new Date().toISOString(),
    // Raw slice the translation is derived from; keeping `names` verbatim makes
    // every later rebuild byte-for-byte reproducible without the network.
    names: res.json.names || [],
  };
  writeCache(group, key, hit);
  stats.fetched += 1;
  return hit;
}

/** PokeAPI's `/list` endpoints: id + slug only, `names` come per resource. */
async function pokeList(group, resource, perPage, opts, stats) {
  let hit = opts.refresh
    ? null
    : readCache(group, `${resource}-list`, (r) => !!r && Array.isArray(r.results));
  if (hit) {
    stats.listCacheHits += 1;
    return hit;
  }
  if (opts.offline) return null;
  const pages = [];
  for (let offset = 0; ; offset += perPage) {
    const res = await fetchJson(
      `https://pokeapi.co/api/v2/${resource}?limit=${Math.min(perPage, 1000)}&offset=${offset}`
    );
    if (!res.json) {
      stats.errors.push(`${resource} list: ${res.error}`);
      return null;
    }
    pages.push(...(res.json.results || []));
    if (offset + perPage >= (res.json.count || 0) || !(res.json.results || []).length) break;
  }
  hit = {
    fetchedAt: new Date().toISOString(),
    results: pages.map((r) => ({
      name: r.name,
      id: Number((r.url.match(/\/(\d+)\/?$/) || [])[1]),
    })),
  };
  writeCache(group, `${resource}-list`, hit);
  stats.listFetched += 1;
  return hit;
}

/* -------------------------------------------------------- zh-hans picking -- */

/** Pick the Simplified Chinese label; Traditional forms are never accepted. */
function pickZhHans(names) {
  const hit = (names || []).find(
    (n) =>
      n && n.language && n.language.name === 'zh-hans' && typeof n.name === 'string' && n.name.trim()
  );
  return hit ? hit.name.trim() : null;
}

/** PokeAPI's own English spelling of a resource (used for the round-trip). */
function pickEn(names) {
  const hit = (names || []).find(
    (n) => n && n.language && n.language.name === 'en' && typeof n.name === 'string' && n.name.trim()
  );
  return hit ? hit.name.trim() : null;
}

/** True when the API resource really is the term we asked for. */
function roundTrips(displayName, detail, expectedEn) {
  const slug = norm(detail && detail.slug);
  const en = norm(pickEn((detail && detail.names) || []));
  if (expectedEn) return !!en && en === norm(expectedEn);
  const want = norm(displayName);
  if (!want) return false;
  return slug === want || (!!en && en === want);
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

/**
 * Derive the term lists from the upstream data instead of hand-picking them, so
 * the table can never drift away from what the site actually renders.
 */
function collectVocabulary() {
  const alpha = readJson(F_ALPHA, {});
  const swarm = readJson(F_SWARM, {});
  const pheno = readJson(F_PHENO, {});
  const alphapedia = readJson(F_ALPHAPEDIA, {});
  const pokesearch = readJson(F_POKESEARCH, []);

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

  // pheno is { location: { weatherType: { Pokemon, Specific Locations, HMs } } }
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

/* ----------------------------------------------------------- manual tables -- */

/**
 * Legacy English labels carried by the upstream (PokeMMO era) data whose modern
 * PokeAPI slug / English name differs, so normalization alone cannot find them.
 * Each entry states the expected `en` name and why the mapping is right; the
 * build refuses the alias unless the fetched resource round-trips to `en`.
 */
const MOVE_ALIASES = {
  // Gen III-V English name, renamed in Gen VI.
  'Faint Attack': { slug: 'feint-attack', en: 'Feint Attack' },
  // Hi Jump Kick -> High Jump Kick (Gen VI spelling fix).
  'Hi Jump Kick': { slug: 'high-jump-kick', en: 'High Jump Kick' },
  // Older singular label for `smelling-salts` ("Smelling Salts").
  SmellingSalt: { slug: 'smelling-salts', en: 'Smelling Salts' },
};

/** Same problem on the ability side, disambiguated by ability slot order. */
const ABILITY_ALIASES = {
  // Black/White name for Slush Rush; slot 2 of Cubchoo/Beartic.
  'Snow Plow': { slug: 'slush-rush', en: 'Slush Rush' },
  // Slot 2 of Koffing/Weezing is Neutralizing Gas, the only *Gas ability.
  'Reactive Gas': { slug: 'neutralizing-gas', en: 'Neutralizing Gas' },
};

/**
 * HM labels the move table cannot answer go here (HM items are named after
 * their move, so normally this stays empty). Values are the same shape as
 * MOVE_ALIASES. Anything resolved from this table is emitted as `manual`.
 */
const MANUAL_HM = {
  // example: 'Teleport': { slug: 'teleport', en: 'Teleport' },
};

/**
 * Ball genera. PokeAPI has no "Ultra 2025" item, so the genus is translated by
 * hand and the trailing token is kept verbatim. `item` names the PokeAPI item
 * whose zh-hans name must agree, otherwise the entry is emitted as null - that
 * keeps this table honest across rebuilds.
 */
const MANUAL_BALL_GENUS = {
  Great: { cn: '超级球', item: 'great-ball', en: 'Great Ball' },
  Ultra: { cn: '高级球', item: 'ultra-ball', en: 'Ultra Ball' },
  Dusk: { cn: '黑暗球', item: 'dusk-ball', en: 'Dusk Ball' },
  Cherish: { cn: '贵重球', item: 'cherish-ball', en: 'Cherish Ball' },
};

/**
 * UI / game-concept labels taken from the upstream Simplified Chinese catalog
 * verbatim (never invented). Weather keys and egg group labels come from the
 * data; the rest are the column and card headings the site and the WeCom cards
 * show. Keys missing from the catalog are emitted as null.
 */
const CONCEPT_UI_KEYS = [
  'Alpha', 'Alphas', 'Alpha Pokemon',
  'Swarm', 'Swarms',
  'Horde', 'Hordes',
  'Phenos',
  'Dust Pheno', 'Grass Pheno', 'Shadow Pheno', 'Water Pheno',
  'HMs', 'Egg Group', 'Male Ratio', 'Male', 'Female', 'Tier', 'Shiny Tier',
  'Region', 'Location', 'Locations', 'Specific Location', 'Notes',
  'Ability', 'Move', 'Type', 'Moveset', 'Egg Move',
  'Ball', 'Balls', 'Mysterious Balls',
  'Raid', 'Event', 'Events', 'Encounter', 'Spawn', 'Spawns',
  'Time Slot', 'Season', 'Weather', 'History', 'Pokemon', 'Valuable',
];

/** Capitalized display form, so `water a` and `Water A` share one entry. */
function titleCase(value) {
  return String(value)
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/* -------------------------------------------------------------------- i18n -- */

async function loadI18nCatalog(opts, stats) {
  let doc = fs.existsSync(I18N_FILE) ? readJson(I18N_FILE, null) : null;
  if (!doc && !opts.offline) {
    const res = await fetchJson(I18N_URL);
    if (res.json) {
      doc = res.json;
      // Ship the catalog next to the other upstream payloads, but never
      // overwrite a file that is already there.
      fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
      fs.writeFileSync(I18N_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      say(`wrote ${path.relative(ROOT, I18N_FILE)} (upstream zh catalog)`);
      stats.i18nFetched = true;
    } else {
      stats.errors.push(`i18n catalog: ${res.error}`);
    }
  }
  if (!doc) {
    doc = readCache('lists', 'i18n-zh', (r) => !!r && typeof r === 'object');
    if (doc) stats.i18nFromCache = true;
  }
  if (!doc) return { ui: {}, notes: {} };
  if (!fs.existsSync(I18N_FILE)) writeCache('lists', 'i18n-zh', doc);
  const translations = (doc.add_translation && doc.add_translation.translations) || {};
  return {
    ui: translations.ui || {},
    notes: translations.notes || {},
  };
}

/** Drop a trailing ASCII parenthetical that just repeats the key. */
function tidyCatalogValue(key, value) {
  const text = String(value).trim();
  const match = text.match(/^(.*?)[\s]*(?:\(([^()]*)\)|（([^（）]*)）)$/);
  if (!match) return text;
  const inner = match[2] !== undefined ? match[2] : match[3];
  if (!inner || !/^[A-Za-z ]+$/.test(inner)) return text; // Chinese gloss, keep it
  const a = norm(inner);
  const b = norm(key);
  if (!a || !(a === b || b.includes(a) || a.includes(b))) return text;
  return match[1].trim();
}

/* ------------------------------------------------------------------ moves -- */

/**
 * Resolve a list of display names against one PokeAPI list endpoint.
 * Returns `{ byName: Map(normalized display -> {slug, id, alias}) }`.
 */
function buildSlugIndex(list) {
  const index = new Map();
  const collisions = [];
  for (const row of list) {
    const key = norm(row.name);
    if (!key) continue;
    if (index.has(key)) collisions.push(row.name);
    else index.set(key, { slug: row.name, id: row.id });
  }
  return { index, collisions };
}

async function resolveTerms(displayNames, { list, aliases, group, resource, aliasNote }, opts, stats) {
  const { index, collisions } = buildSlugIndex(list);
  if (collisions.length) {
    stats.errors.push(`${resource}: ${collisions.length} slugs collapse to the same key (${collisions.slice(0, 5).join(', ')} ...)`);
  }

  const plans = [];
  const unresolved = [];
  const seen = new Set();
  for (const display of displayNames) {
    if (seen.has(display)) continue;
    seen.add(display);
    const direct = index.get(norm(display));
    if (direct) {
      plans.push({ display, ...direct, alias: null });
      continue;
    }
    const alias = has(aliases, display) ? aliases[display] : null;
    if (alias) {
      const bySlug = list.find((row) => row.name === alias.slug);
      if (bySlug) {
        plans.push({ display, slug: bySlug.name, id: bySlug.id, alias });
        continue;
      }
    }
    unresolved.push(display);
  }

  const results = {};
  const errors = await runPool(plans, CONCURRENCY, async (plan) => {
    const detail = await pokeResource(group, resource, plan.id, plan.slug, opts, stats);
    if (!detail) {
      results[plan.display] = {
        cn: null,
        source: opts.offline ? 'cache-miss' : 'pokeapi',
        note: 'no cached response and no network',
      };
      return;
    }
    if (!roundTrips(plan.display, detail, plan.alias ? plan.alias.en : null)) {
      stats.mismatch.push(`${plan.display} -> ${resource}/${detail.slug || plan.slug}`);
      results[plan.display] = {
        cn: null,
        source: plan.alias ? 'manual' : 'pokeapi',
        note: `english name round-trip failed (${pickEn(detail.names) || detail.slug})`,
      };
      return;
    }
    const cn = pickZhHans(detail.names);
    const source = plan.alias ? 'manual' : 'pokeapi';
    if (!cn) {
      const hantOnly = (detail.names || []).some((n) => n && n.language && n.language.name === 'zh-hant');
      stats.noZhHans.push(`${plan.display} (${detail.slug})`);
      results[plan.display] = {
        cn: null,
        source,
        note: hantOnly ? 'pokeapi has zh-hant only' : 'no chinese name in pokeapi',
      };
      return;
    }
    const entry = { cn, source };
    if (plan.alias) entry.note = `${aliasNote}: ${plan.alias.en} (pokeapi ${resource}/${plan.slug})`;
    results[plan.display] = entry;
  });
  if (errors.length) say(`warn: ${errors.length} unexpected pool errors`);

  for (const display of unresolved) {
    stats.unresolved.push(`${resource}: ${display}`);
    results[display] = { cn: null, source: 'no-match', note: `no ${resource} match in pokeapi` };
  }
  return results;
}

/* ------------------------------------------------------------------- main -- */

(async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    offline: argv.includes('--offline'),
    refresh: argv.includes('--refresh'),
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const stats = {
    cacheHits: 0,
    fetched: 0,
    failed: 0,
    cacheMisses: 0,
    listCacheHits: 0,
    listFetched: 0,
    i18nFetched: false,
    i18nFromCache: false,
    mismatch: [],
    noZhHans: [],
    unresolved: [],
    errors: [],
  };

  say(`build-cn-terms  (${opts.offline ? 'offline: cache only' : 'network allowed'}${opts.refresh ? ', refresh' : ''})`);

  const vocab = collectVocabulary();
  say('');
  say('--- vocabulary derived from data/upstream ---');
  say(`hms        : ${vocab.hms.length}`);
  say(`moves      : ${vocab.moves.length}`);
  say(`abilities  : ${vocab.abilities.length}`);
  say(`types      : ${vocab.types.length} (in our data)`);
  say(`balls      : ${vocab.balls.length}`);
  say(`weather    : ${vocab.weather.join(', ')}`);
  say(
    `egg groups : ${new Set(vocab.eggGroups.map(titleCase)).size} distinct ` +
      `(${vocab.eggGroups.length} raw spellings, e.g. "Water A" vs "water a")`
  );

  const [moveList, abilityList, typeList] = await Promise.all([
    pokeList('lists', 'move', 1000, opts, stats),
    pokeList('lists', 'ability', 400, opts, stats),
    pokeList('lists', 'type', 40, opts, stats),
  ]);
  if (!moveList || !abilityList || !typeList) {
    throw new Error('PokeAPI list endpoints unavailable and no cache - run without --offline once');
  }
  const counts = { move: moveList.results.length, ability: abilityList.results.length, type: typeList.results.length };
  say('');
  say(`--- pokeapi lists --- move ${counts.move}, ability ${counts.ability}, type ${counts.type}`);

  const moves = await resolveTerms(vocab.moves, {
    list: moveList.results,
    aliases: MOVE_ALIASES,
    group: 'moves',
    resource: 'move',
    aliasNote: 'legacy pokemmo label',
  }, opts, stats);

  const abilities = await resolveTerms(vocab.abilities, {
    list: abilityList.results,
    aliases: ABILITY_ALIASES,
    group: 'abilities',
    resource: 'ability',
    aliasNote: 'legacy pokemmo label',
  }, opts, stats);

  // Types: our data uses uppercase (`GRASS`), PokeAPI is lowercase. Emit the 18
  // canonical damage types (a superset of what our data uses today, so the
  // filters stay translated when a new type shows up) keyed by the original
  // uppercase string.
  const typeResults = await resolveTerms(vocab.types, {
    list: typeList.results,
    aliases: {},
    group: 'types',
    resource: 'type',
    aliasNote: '',
  }, opts, stats);
  const canonicalTypes = typeList.results
    .filter((row) => !/^(stellar|unknown|shadow)$/.test(row.name))
    .map((row) => row.name.toUpperCase());
  const types = { ...typeResults };
  const missingTypes = canonicalTypes.filter((t) => !has(types, t));
  if (missingTypes.length) {
    Object.assign(
      types,
      await resolveTerms(missingTypes, {
        list: typeList.results,
        aliases: {},
        group: 'types',
        resource: 'type',
        aliasNote: '',
      }, opts, stats)
    );
  }

  // HMs are named after their move: reuse the move table, then the hand table.
  const hms = {};
  const hmFromManual = [];
  const hmUnresolved = [];
  for (const label of vocab.hms) {
    const viaMove = has(moves, label) ? moves[label] : null;
    if (viaMove && viaMove.cn) {
      hms[label] = { cn: viaMove.cn, source: viaMove.source };
      continue;
    }
    const manual = has(MANUAL_HM, label) ? MANUAL_HM[label] : null;
    if (manual) {
      const detail = await pokeResource('moves', 'move', manual.slug, manual.slug, opts, stats);
      const cn = detail && roundTrips(label, detail, manual.en) ? pickZhHans(detail.names) : null;
      if (cn) {
        hms[label] = { cn, source: 'manual', note: `hand table: pokeapi move/${manual.slug}` };
        hmFromManual.push(label);
        continue;
      }
    }
    hms[label] = viaMove || { cn: null, source: 'no-match', note: 'not in the move table' };
    hmUnresolved.push(label);
  }

  // Balls: split "<genus> <token>", translate the genus, keep the token verbatim.
  const parseBall = (label) => {
    const match = String(label).match(/^(.*?)(\s+\S+)?$/);
    const genus = ((match && match[1]) || '').trim();
    const token = (match && match[2]) || '';
    return { genus, token };
  };
  const balls = {};
  const genusNeeded = new Set();
  for (const label of vocab.balls) {
    const { genus } = parseBall(label);
    if (has(MANUAL_BALL_GENUS, genus)) genusNeeded.add(genus);
  }
  const genusChecks = {};
  for (const genus of [...genusNeeded].sort()) {
    const spec = MANUAL_BALL_GENUS[genus];
    const detail = await pokeResource('items', 'item', spec.item, spec.item, opts, stats);
    if (!detail) {
      genusChecks[genus] = { cn: spec.cn, note: 'item cache miss, hand table value kept unverified' };
      continue;
    }
    const apiCn = pickZhHans(detail.names);
    const en = pickEn(detail.names);
    if (apiCn && en && norm(en) === norm(spec.en) && apiCn === spec.cn) {
      genusChecks[genus] = { cn: apiCn, note: `verified: pokeapi item/${spec.item}` };
    } else {
      genusChecks[genus] = {
        cn: null,
        note: `hand table ${spec.cn} vs pokeapi item/${spec.item} ${apiCn || 'n/a'} / ${en || 'n/a'}`,
      };
      stats.errors.push(`ball genus ${genus}: hand table disagrees with pokeapi`);
    }
  }
  for (const label of vocab.balls) {
    const { genus, token } = parseBall(label);
    const found = has(genusChecks, genus) ? genusChecks[genus] : null;
    if (!found || !found.cn) {
      balls[label] = { cn: null, source: 'manual', note: (found && found.note) || 'genus not in the hand table' };
      continue;
    }
    balls[label] = { cn: found.cn + token, source: 'manual', note: found.note };
    if (!has(balls, genus)) {
      // The UI also looks the bare genus up (refdata.js strips the year).
      balls[genus] = { cn: found.cn, source: 'manual', note: found.note };
    }
  }

  /* concepts: the upstream zh catalog, verbatim. */
  const catalog = await loadI18nCatalog(opts, stats);
  const concepts = {};
  const catalogKeys = { ...catalog.ui, ...catalog.notes };
  const catalogValue = (key) => {
    const raw = catalogKeys[key];
    return typeof raw === 'string' && raw.trim() ? tidyCatalogValue(key, raw) : null;
  };
  const skippedUiKeys = [];

  // (1) weather keys come from the data (Dust / Grass / Shadow / Water) and must
  //     always exist as entries, even when the catalog stops shipping one.
  for (const weatherKey of vocab.weather) {
    const cn = catalogValue(weatherKey);
    concepts[weatherKey] = cn
      ? { cn, source: 'alphapedia-i18n' }
      : { cn: null, source: 'no-match', note: 'weather key not in the upstream zh catalog' };
  }

  // (2) curated UI labels: only emit what the catalog actually answers, so a
  //     missing heading stays out of the table instead of becoming dead weight.
  for (const key of CONCEPT_UI_KEYS) {
    if (has(concepts, key)) continue;
    const cn = catalogValue(key);
    if (cn) concepts[key] = { cn, source: 'alphapedia-i18n' };
    else skippedUiKeys.push(key);
  }

  // (3) `Pheno` ships only inside compounds ("Dust Pheno" -> 卷尘奇遇): strip the
  //     weather translation we already have and require every compound to agree.
  const phenoGuesses = [];
  for (const weatherKey of vocab.weather) {
    const compound = catalogKeys[`${weatherKey} Pheno`];
    const weatherCn = concepts[weatherKey] && concepts[weatherKey].cn;
    if (typeof compound === 'string' && weatherCn && compound.startsWith(weatherCn)) {
      phenoGuesses.push(compound.slice(weatherCn.length).trim());
    }
  }
  if (phenoGuesses.length >= 2 && phenoGuesses.every((g) => g === phenoGuesses[0])) {
    concepts.Pheno = { cn: phenoGuesses[0], source: 'alphapedia-i18n', note: `derived from ${phenoGuesses.length} "<weather> Pheno" catalog entries` };
  } else {
    concepts.Pheno = { cn: null, source: 'no-match', note: 'catalog ships Pheno only in compounds that do not agree' };
  }
  // The four compound headings are what the pheno cards show.
  for (const weatherKey of vocab.weather) {
    const compoundKey = `${weatherKey} Pheno`;
    const cn = catalogValue(compoundKey);
    if (cn) concepts[compoundKey] = { cn, source: 'alphapedia-i18n' };
  }

  // (4) egg groups: the catalog only carries `Genderless` and PokeAPI ships no
  //     zh names for egg groups, so everything else is a documented null that
  //     data/cn-overrides.json can fill.
  const eggGroupKeys = new Map();
  for (const group of vocab.eggGroups) {
    const canonical = titleCase(group);
    if (!eggGroupKeys.has(norm(canonical))) eggGroupKeys.set(norm(canonical), canonical);
  }
  for (const [, canonical] of [...eggGroupKeys].sort()) {
    if (has(concepts, canonical)) continue;
    const cn = catalogValue(canonical) || catalogValue(canonical.toLowerCase());
    concepts[canonical] = cn
      ? { cn, source: 'alphapedia-i18n' }
      : { cn: null, source: 'no-match', note: 'egg group: absent from both the upstream zh catalog and pokeapi' };
  }

  const out = {
    moves: sortObject(moves),
    abilities: sortObject(abilities),
    types: sortObject(types),
    hms: sortObject(hms),
    balls: sortObject(balls),
    concepts: sortObject(concepts),
  };
  writeJson(OUT_FILE, out);

  /* ------------------------------------------------------------- report -- */

  const reportCategory = (name, map, expected) => {
    const keys = Object.keys(map);
    const filled = keys.filter((k) => typeof map[k].cn === 'string' && map[k].cn.trim());
    const nulls = keys.filter((k) => !filled.includes(k));
    say('');
    say(`--- ${name} ---`);
    say(`distinct in data : ${expected === undefined ? keys.length : expected}`);
    say(`entries written  : ${keys.length}`);
    say(`filled           : ${filled.length}`);
    say(`null             : ${nulls.length}`);
    if (nulls.length) say(`null entries     : ${nulls.join(', ')}`);
    return { keys, filled, nulls };
  };

  const rMoves = reportCategory('moves', out.moves, vocab.moves.length);
  const rAbil = reportCategory('abilities', out.abilities, vocab.abilities.length);
  const rTypes = reportCategory('types', out.types, `${vocab.types.length} in data / 18 canonical`);
  const rHms = reportCategory('hms', out.hms, vocab.hms.length);
  const rBalls = reportCategory('balls', out.balls, `${vocab.balls.length} labels (+ bare genera)`);
  const rConcepts = reportCategory(
    'concepts',
    out.concepts,
    `${vocab.weather.length} weather + ${eggGroupKeys.size} egg groups + curated UI labels`
  );

  say('');
  say('--- provenance split ---');
  const sourceTally = {};
  for (const map of Object.values(out)) {
    for (const entry of Object.values(map)) sourceTally[entry.source] = (sourceTally[entry.source] || 0) + 1;
  }
  say(`  ${Object.entries(sourceTally).map(([s, n]) => `${s}=${n}`).join(', ')}`);
  say(`  hms via move table : ${vocab.hms.length - hmFromManual.length - hmUnresolved.length}`);
  say(`  hms via hand table : ${hmFromManual.length}${hmFromManual.length ? ` (${hmFromManual.join(', ')})` : ''}`);
  say(`  hms unresolved     : ${hmUnresolved.length}${hmUnresolved.length ? ` (${hmUnresolved.join(', ')})` : ''}`);
  say(`  balls via hand table: ${genusNeeded.size} genera (${[...genusNeeded].sort().join(', ')})`);
  if (skippedUiKeys.length) {
    say(`  ui labels not shipped by the upstream zh catalog (skipped, ${skippedUiKeys.length}): ${skippedUiKeys.join(', ')}`);
  }

  say('');
  say('--- cache / network ---');
  say(`  detail cache hits : ${stats.cacheHits}`);
  say(`  detail fetched    : ${stats.fetched}`);
  say(`  cache misses      : ${stats.cacheMisses}`);
  say(`  fetch failures    : ${stats.failed}`);
  say(`  list cache hits   : ${stats.listCacheHits} / fetched ${stats.listFetched}`);
  say(`  i18n catalog      : ${stats.i18nFetched ? 'fetched' : stats.i18nFromCache ? 'cache' : 'data/upstream/i18n-zh.json'}${catalog ? ` (ui ${Object.keys(catalog.ui).length}, notes ${Object.keys(catalog.notes).length})` : ''}`);

  if (stats.unresolved.length) {
    say('');
    say(`  no pokeapi match (${stats.unresolved.length}): ${stats.unresolved.join(', ')}`);
  }
  if (stats.noZhHans.length) {
    say(`  zh-hans missing (${stats.noZhHans.length}): ${stats.noZhHans.join(', ')}`);
  }
  if (stats.mismatch.length) {
    say(`  round-trip mismatches (${stats.mismatch.length}): ${stats.mismatch.join(', ')}`);
  }
  if (stats.errors.length) {
    say(`  errors (${stats.errors.length}): ${stats.errors.slice(0, 10).join(' | ')}`);
  }

  const totalNulls = [rMoves, rAbil, rTypes, rHms, rBalls, rConcepts].reduce((n, r) => n + r.nulls.length, 0);
  // Nulls are a deliberate, honest end state (the UI falls back to English);
  // failed fetches, offline cache misses and failed round-trips are not.
  const blocking =
    stats.failed > 0 ||
    stats.cacheMisses > 0 ||
    hmUnresolved.length > 0 ||
    stats.mismatch.length > 0;
  say('');
  say(
    `RESULT: ${blocking ? 'FAIL' : 'OK'} (${totalNulls} null entries kept as English fallback` +
      `${stats.failed ? `, ${stats.failed} fetch failure(s)` : ''}` +
      `${stats.cacheMisses ? `, ${stats.cacheMisses} offline cache miss(es)` : ''})`
  );
  if (!CONSOLE_IS_UTF8) {
    say('note: non-UTF-8 console detected; Chinese output above is \\uXXXX escaped. Files are UTF-8.');
  }
  process.exitCode = blocking ? 1 : 0;
})().catch((err) => {
  say(`FATAL ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
