#!/usr/bin/env node
"use strict";
/* 生成 GitHub Pages 用的静态快照 dist/：把看板数据写成 data.json，前端切到静态模式读它。
   单独跑：node tools/build-static.js [--data=state]
   Actions 里由 tools/actions-sync.js 调用。 */

const fs = require("fs");
const path = require("path");
const { Store } = require("../src/store");
const { boardData } = require("../src/board");
const refdata = require("../src/refdata");

const ROOT = path.resolve(__dirname, "..");
const argDir = (process.argv.find((a) => a.startsWith("--data=")) || "--data=data").split("=")[1];
const DATA_DIR = path.resolve(ROOT, argDir);
const PUB = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

function copy(rel) {
  const from = path.join(PUB, rel);
  const to = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
}

function main(dataDir) {
  const store = new Store(dataDir ? path.resolve(ROOT, dataDir) : DATA_DIR);
  store.load();
  const board = boardData(store, { mode: "static" });
  const options = refdata.options();

  fs.mkdirSync(DIST, { recursive: true });
  /* 图鉴参考页需要每个地点的点位明细，静态模式下没有后端接口，只能一并烘进快照 */
  const refLocations = {};
  for (const list of Object.values(options.locationsByRegion)) {
    for (const l of list) refLocations[l.en] = refdata.atLocation(l.en);
  }
  const payload = {
    board,
    options,
    refLocations,
    windows: require("../src/config").readConfig().windows,
    note: "静态快照模式：数据由 GitHub Actions 定时抓取生成，点位上报与推送需要自建服务。",
  };
  fs.writeFileSync(path.join(DIST, "data.json"), JSON.stringify(payload), "utf8");

  copy("styles.css");
  copy("app.js");
  copy("assets/favicon.svg");

  /* Pages 可能挂在仓库子路径下，绝对路径会 404，这里一律改成相对路径并打开静态模式 */
  let html = fs.readFileSync(path.join(PUB, "index.html"), "utf8");
  html = html
    .replace(/\/styles\.css/g, "styles.css")
    .replace(/\/app\.js/g, "app.js")
    .replace(/\/assets\/favicon\.svg/g, "assets/favicon.svg")
    .replace(/<a class="tab link" href="\/admin">管理<\/a>/, "")
    .replace('<script src="app.js', '<script>window.__STATIC__ = true;</script>\n    <script src="app.js');
  fs.writeFileSync(path.join(DIST, "index.html"), html, "utf8");

  console.log(`dist 生成完成：活动点位 ${board.stats.active}，库存 ${board.stats.stored}，数据 ${(JSON.stringify(payload).length / 1024).toFixed(0)}KB`);
}

if (require.main === module) main(argDir);
module.exports = { main };
