"use strict";
/* JSON 文件持久层。数据量级只有几千条，不值得引入数据库：
   - 读：进程启动时全量进内存
   - 写：临时文件 + rename 原子替换，避免进程被 kill 时写出半个 db.json
   - 事件按 key 去重，本地审核通过的上报和上游报点共用一张表 */

const fs = require("fs");
const path = require("path");

const VERSION = 1;

function blank() {
  return {
    version: VERSION,
    meta: { seededAt: null, lastSyncAt: null, lastSyncError: "", cursors: { alpha: 0, swarm: 0, pheno: 0 }, syncLog: [] },
    events: [],
    reports: [],
    queue: [],
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.db = blank();
    this._timer = null;
  }

  load() {
    let text = null;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      this.db = blank();
      this.index = new Map();
      return this.db;
    }
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      raw = null;
    }
    if (raw && raw.version === VERSION) {
      const base = blank();
      this.db = { ...base, ...raw, meta: { ...base.meta, ...(raw.meta || {}) } };
      this.db.queue = Array.isArray(raw.queue) ? raw.queue : [];
    } else {
      /* 解析失败或版本不符都先把原文件留着，坏掉的 db 里可能还有能救的上报记录 */
      const why = raw ? "版本不匹配" : "解析失败";
      console.warn(`[store] db.json ${why}，已备份为 db.json.bak-* 并重建`);
      try {
        fs.copyFileSync(this.file, this.file + ".bak-" + Date.now());
      } catch (e) {
        /* 备份失败不挡住启动 */
      }
      this.db = blank();
    }
    this.index = new Map(this.db.events.map((ev) => [ev.key, ev]));
    return this.db;
  }

  flush() {
    this.db.events = [...this.index.values()];
    const tmp = this.file + ".tmp";
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 0), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /* 合并一批事件，返回真正新增的条数（调用方据此判断要不要推送） */
  putEvents(list) {
    let added = 0;
    for (const ev of [].concat(list)) {
      if (!ev || !ev.key) continue;
      if (this.index.has(ev.key)) continue;
      this.index.set(ev.key, ev);
      added++;
    }
    if (added) this.scheduleFlush();
    return added;
  }

  getEvent(key) {
    return this.index.get(key);
  }

  events(opts = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    let list = [...this.index.values()];
    if (opts.kind) list = list.filter((e) => e.kind === opts.kind);
    if (opts.source) list = list.filter((e) => e.source === opts.source);
    if (opts.activeOnly) list = list.filter((e) => (e.expiresUnix || e.tsUnix) > nowSec);
    if (opts.region) list = list.filter((e) => e.region === opts.region);
    if (opts.q) {
      const q = String(opts.q).toLowerCase();
      list = list.filter((e) => `${e.pokemon} ${e.pokemonCn || ""} ${e.location} ${e.locationCn || ""}`.toLowerCase().includes(q));
    }
    list.sort((a, b) => b.tsUnix - a.tsUnix);
    const limit = opts.limit ?? 200;
    return { total: list.length, rows: list.slice(0, limit) };
  }

  /* 把过期的事件标出来，同时按保留窗口裁剪，防止 db.json 无限膨胀 */
  prune(retentionDays = 7) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    let removed = 0;
    for (const [key, ev] of [...this.index.entries()]) {
      if ((ev.expiresUnix || ev.tsUnix) < cutoff) {
        this.index.delete(key);
        removed++;
      }
    }
    if (removed) this.scheduleFlush();
    return removed;
  }

  logSync(entry) {
    const m = this.db.meta;
    m.lastSyncAt = new Date().toISOString();
    m.lastSyncError = entry.error || "";
    m.syncLog = [...(m.syncLog || []).slice(-49), { at: m.lastSyncAt, ...entry }];
  }

  save() {
    this.db.events = [...this.index.values()];
    this.flush();
  }

  scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this.flush();
      } catch (e) {
        console.error("[store] 写入失败:", e.message);
      }
    }, 400);
  }
}

/* key 用英文原名拼：上游和玩家输入都会先经过 normalize，大小写差异在那一步收敛 */
function eventKey({ kind, pokemon, location, tsUnix, phenoType }) {
  return [kind, String(pokemon || "").toLowerCase(), String(location || "").toLowerCase(), phenoType || "", tsUnix].join("|");
}

module.exports = { Store, eventKey, blank };
