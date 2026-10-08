"use strict";
/* 一轮同步：增量拉 Alpha/Swarm 事件流水，顺带定期刷新静态参考表。
   返回本轮真正新增的事件列表，供推送模块判断要不要发。 */

const fs = require("fs");
const path = require("path");
const up = require("./upstream");
const dict = require("./dict");
const { fromUpstream } = require("./normalize");

const UP_DIR = path.resolve(__dirname, "..", "data", "upstream");
const STATIC_TTL_MS = 12 * 3600 * 1000;

/* 日志与错误提示给人看，用中文类型名；perKind / cursors 这些键仍按英文原样存 */
const zhKind = (kind) => dict.concept({ alpha: "Alpha", swarm: "Swarm", pheno: "Pheno" }[kind] || kind);

async function refreshStatic(log) {
  const marker = path.join(UP_DIR, ".fetched-at");
  let stale = true;
  try {
    stale = Date.now() - fs.statSync(marker).mtimeMs > STATIC_TTL_MS;
  } catch (e) {
    stale = true;
  }
  if (!stale) return { staticRefreshed: false };
  fs.mkdirSync(UP_DIR, { recursive: true });
  const done = [];
  for (const name of Object.keys(up.STATIC_ENDPOINTS)) {
    try {
      const json = await up.fetchStatic(name, log);
      fs.writeFileSync(path.join(UP_DIR, up.STATIC_FILES[name]), JSON.stringify(json), "utf8");
      done.push(name);
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      log(`静态表 ${name} 刷新失败: ${e.message}`);
    }
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch (e) {
    /* 只影响下次是否重复拉取 */
  }
  return { staticRefreshed: true, staticTables: done };
}

async function syncOnce(store, cfg, { log = () => {} } = {}) {
  const started = Date.now();
  const nowUnix = Math.floor(Date.now() / 1000);
  const newEvents = [];
  const errors = [];
  const perKind = {};

  for (const kind of ["alpha", "swarm"]) {
    const cursor = Number(store.db.meta.cursors[kind] || 0);
    const cutoff = cursor ? 0 : nowUnix - cfg.sync.backfillHours * 3600;
    try {
      const rows = await up.collectNew(kind, {
        cursor,
        cutoffUnix: cutoff,
        maxPages: cursor ? 3 : 10,
        log,
      });
      let maxId = cursor;
      let inserted = 0;
      for (const row of rows) {
        if (Number(row.id) > maxId) maxId = Number(row.id);
        if (cursor && Number(row.id) <= cursor) continue;
        const ev = fromUpstream(row, kind, cfg.windows);
        if (!ev.tsUnix) continue;
        if (!store.index.has(ev.key)) {
          newEvents.push(ev);
          inserted++;
        }
        store.putEvents(ev);
      }
      store.db.meta.cursors[kind] = maxId;
      perKind[kind] = { fetched: rows.length, inserted, cursor: maxId };
      log(`${zhKind(kind)}: 取回 ${rows.length} 行，新增 ${inserted} 条，游标 -> ${maxId}`);
    } catch (e) {
      /* 这条会进管理台的"错误"列，用中文类型名，别把 alpha/swarm 原始键甩给站主 */
      errors.push(`${zhKind(kind)}: ${e.message}`);
      log(`${zhKind(kind)} 同步失败: ${e.message}`);
    }
  }

  const st = await refreshStatic(log);
  const removed = store.prune(cfg.sync.retentionDays);

  newEvents.sort((a, b) => a.tsUnix - b.tsUnix);
  store.logSync({
    ms: Date.now() - started,
    alphaAdded: perKind.alpha ? perKind.alpha.inserted : 0,
    swarmAdded: perKind.swarm ? perKind.swarm.inserted : 0,
    pruned: removed,
    error: errors.join("; "),
  });
  store.save();
  return { newEvents, perKind, errors, removed, ms: Date.now() - started, ...st };
}

module.exports = { syncOnce, refreshStatic };
