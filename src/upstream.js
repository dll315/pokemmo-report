"use strict";
/* Alphapedia 上游抓取器。
   两类接口：
   1) 静态参考表（/api/alpha-spawn-data 等）——匿名 GET 即可；
   2) 事件流水（/api/history-data、/api/swarm-history-data）——必须先 GET 一个 HTML 页面，
      从 <meta name="history-api-token"> 取一次性令牌，并在同一个会话 cookie 下带 X-History-Token 调用。
      令牌不对时上游不报错，只返回空数组 + totalRows:0，所以这里要把"空"当成失败处理。 */

const { request, makeJar, sleep } = require("./net");

const BASE = process.env.UPSTREAM_BASE || "https://alpha.pokemmotools.org";

/* kind -> 用来取令牌的页面路径 */
const TOKEN_PAGES = { alpha: "/history", swarm: "/swarm-history" };
const HISTORY_PATH = { alpha: "/api/history-data", swarm: "/api/swarm-history-data" };

const STATIC_ENDPOINTS = {
  alpha: "/api/alpha-spawn-data",
  swarm: "/api/swarm-spawn-data",
  pheno: "/api/pheno-spawn-data",
  alphapedia: "/api/alphapedia-data",
  natdex: "/api/pokemon-natdex-map",
  pokesearch: "/api/pokesearch-data",
};

/* 落盘文件名必须和读取方一致（refdata.js / normalize.js 读的是这些长名），
   否则定时刷新会写到没人读的文件里 */
const STATIC_FILES = {
  alpha: "alpha-spawn-data.json",
  swarm: "swarm-spawn-data.json",
  pheno: "pheno-spawn-data.json",
  alphapedia: "alphapedia-data.json",
  natdex: "pokemon-natdex-map.json",
  pokesearch: "pokesearch-data.json",
};

function readToken(html) {
  const m = /name="history-api-token"\s+content="([^"]+)"/.exec(html || "");
  return m ? m[1] : null;
}

/* 建立一次会话：拿到 cookie + 页面令牌 */
async function openSession(kind, log = () => {}) {
  const jar = makeJar();
  const page = TOKEN_PAGES[kind];
  if (!page) throw new Error(`未知的事件类型: ${kind}`);
  const res = await request(BASE + page, { jar });
  const token = readToken(res.text);
  if (!token) throw new Error(`未能从 ${page} 取到 history-api-token（HTTP ${res.status}），上游页面结构可能变了`);
  log(`会话就绪 kind=${kind} cookie=${jar.size} 字节`);
  return { jar, token };
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  return sp.toString();
}

/* 拉一页事件流水。返回 {rows, totalRows, page, totalPages} */
async function fetchHistoryPage(session, kind, params) {
  const qs = buildQuery({ page: 1, pageSize: 100, ...params });
  const res = await request(`${BASE}${HISTORY_PATH[kind]}?${qs}`, {
    jar: session.jar,
    headers: { "X-History-Token": session.token, Accept: "application/json" },
  });
  if (res.status !== 200) throw new Error(`${HISTORY_PATH[kind]} HTTP ${res.status}`);
  const body = res.json;
  if (!body) throw new Error(`${HISTORY_PATH[kind]} 返回不是 JSON`);
  const rows = body.historyData || [];
  /* totalRows 为 0 且本页无数据 = 令牌失效（上游不会报错，只会给你空集） */
  const empty = rows.length === 0 && Number(body.totalRows || 0) === 0;
  return {
    rows,
    totalRows: Number(body.totalRows || 0),
    page: Number(body.page || 1),
    totalPages: Number(body.totalPages || 0),
    summary: body.summary,
    insights: body.insights,
    empty,
  };
}

/* 倒序翻页，直到撞到已知游标或抓满页数。
   上游返回的 id 单调递增、页内倒序，所以"本页最小 id <= 游标"即可停。
   第 1 页就空 = 令牌失效的典型表现，重新引导一次会话再试。 */
async function collectNew(kind, { cursor = 0, cutoffUnix = 0, maxPages = 8, pageSize = 100, log = () => {} } = {}) {
  let session = await openSession(kind, log);
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    let r;
    try {
      r = await fetchHistoryPage(session, kind, { page, pageSize });
    } catch (e) {
      log(`${kind} 第 ${page} 页失败: ${e.message}`);
      break;
    }
    if (r.empty && page === 1 && maxPages > 0) {
      log(`${kind} 令牌失效，重建会话后重试一次`);
      session = await openSession(kind, log);
      r = await fetchHistoryPage(session, kind, { page, pageSize });
      if (r.empty) break;
    }
    if (!r.rows.length) break;
    rows.push(...r.rows);
    const oldest = r.rows[r.rows.length - 1];
    if (cursor && Number(oldest.id) <= cursor) break;
    if (cutoffUnix && toUnix(oldest) && toUnix(oldest) < cutoffUnix) break;
    if (r.totalPages && page >= r.totalPages) break;
    await sleep(700);
  }
  return rows;
}

/* 上游行的 timestampIso/timestampText 是 UTC 但不带时区标记。
   Date.parse("2026-10-04T03:25:52") 会被解释成本地时间，在 UTC+8 机器上整体偏 8 小时，
   所以必须显式补 Z 再解析。 */
function toUnix(row) {
  const iso = row && (row.timestampIso || row.timestampText);
  if (!iso) return 0;
  let s = String(iso).trim().replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += s.length === 16 ? ":00Z" : "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

async function fetchStatic(name, log = () => {}) {
  const path = STATIC_ENDPOINTS[name];
  if (!path) throw new Error(`未知的静态表: ${name}`);
  const res = await request(BASE + path, { headers: { Accept: "application/json" } });
  if (res.status !== 200 || !res.json) throw new Error(`${path} HTTP ${res.status}`);
  log(`${name}: ${(JSON.stringify(res.json).length / 1024).toFixed(0)}KB`);
  return res.json;
}

/* 首页 HTML：拿当前 pheno / swarm / alpha 看板（pheno 没有独立的历史接口，只能从这里解析） */
async function fetchHomeHtml() {
  const res = await request(BASE + "/", { headers: { Accept: "text/html" } });
  if (res.status !== 200) throw new Error(`首页 HTTP ${res.status}`);
  return res.text;
}

module.exports = { BASE, STATIC_ENDPOINTS, STATIC_FILES, openSession, fetchHistoryPage, collectNew, fetchStatic, fetchHomeHtml, toUnix, readToken };
