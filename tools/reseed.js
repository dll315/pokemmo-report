#!/usr/bin/env node
"use strict";
/* 手动重灌一次历史：清空游标，按指定小时数回填。
   必须先停掉 server.js，否则两边同时写 data/db.json 会互相覆盖。
     node tools/reseed.js [小时数]   默认 72 */

const { Store } = require("../src/store");
const sync = require("../src/sync");
const { readConfig } = require("../src/config");
const path = require("path");

const HOURS = Number(process.argv[2] || 72);
const store = new Store(path.resolve(__dirname, "..", "data"));
store.load();
if (store.index.size && !process.argv.includes("--force")) {
  console.log(`已有 ${store.index.size} 条事件。确认要清空重灌请加 --force`);
  process.exit(1);
}
store.db.events = [];
store.index.clear();
store.db.meta.cursors = { alpha: 0, swarm: 0, pheno: 0 };
store.db.meta.seededAt = null;

const cfg = readConfig();
cfg.sync.backfillHours = HOURS;
console.log(`回填最近 ${HOURS} 小时…`);
sync
  .syncOnce(store, cfg, { log: console.log })
  .then((r) => {
    store.db.meta.seededAt = new Date().toISOString();
    store.save();
    console.log(`完成：库存 ${store.index.size} 条，抓取错误 ${r.errors.length ? r.errors.join("; ") : "无"}`);
  })
  .catch((e) => {
    console.error("失败:", e.message);
    process.exit(1);
  });
