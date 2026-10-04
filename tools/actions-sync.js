#!/usr/bin/env node
"use strict";
/* GitHub Actions 每次跑批做三件事：同步上游 → 给新点发企业微信 → 生成 dist 静态快照。
   状态存在仓库里的 state/db.json（工作流会把它提交回去），所以 Actions 这种无运行环境的
   场景也能做到"只推新点、不重复推"。
   用到的环境变量：
     WECOM_WEBHOOK   机器人地址（不填则只更新快照，不推送）
     PUSH_ENABLED=0  临时停推
     PUSH_KINDS      默认 alpha,swarm
     PUSH_ONLY / PUSH_EXCEPT / PUSH_REGIONS / PUSH_MIN_TIER / PUSH_MAX
     BACKFILL_HOURS / RETENTION_DAYS / STATE_DIR */

const path = require("path");
const fs = require("fs");
const { Store } = require("../src/store");
const sync = require("../src/sync");
const push = require("../src/push-wecom");
const { main: buildStatic } = require("./build-static");

const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = process.env.STATE_DIR || "state";
const list = (s) => String(s || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean);

const cfg = {
  wecom: {
    webhook: process.env.WECOM_WEBHOOK || "",
    enabled: process.env.PUSH_ENABLED !== "0",
    kinds: list(process.env.PUSH_KINDS).length ? list(process.env.PUSH_KINDS) : ["alpha", "swarm"],
    onlyPokemon: list(process.env.PUSH_ONLY),
    exceptPokemon: list(process.env.PUSH_EXCEPT),
    regions: list(process.env.PUSH_REGIONS),
    minTier: Number(process.env.PUSH_MIN_TIER || 0),
    maxPerTick: Number(process.env.PUSH_MAX || 8),
    quietHours: { enabled: false, from: "01:00", to: "07:00" },
  },
  sync: { intervalMinutes: 10, backfillHours: Number(process.env.BACKFILL_HOURS || 48), retentionDays: Number(process.env.RETENTION_DAYS || 7) },
  windows: { alphaMinutes: 75, swarmMinutes: 25 },
};

const log = (...a) => console.log("[sync]", ...a);

async function main() {
  fs.mkdirSync(path.resolve(ROOT, STATE_DIR), { recursive: true });
  const store = new Store(path.resolve(ROOT, STATE_DIR));
  store.load();

  const r = await sync.syncOnce(store, cfg, { log });
  log(`新增 ${r.newEvents.length} 条，库存 ${store.index.size} 条，错误 ${r.errors.length ? r.errors.join("; ") : "无"}`);

  /* 一条都没抓到且报错 = 上游拒绝这个 IP（Actions 跑在数据中心，Cloudflare 常直接 403）。
     这种情况必须让这一步红掉：静默成功会部署出一个空看板，比失败更坏。 */
  if (r.errors.length && store.index.size === 0) {
    console.error("\n同步彻底失败：上游一个数据都没给。多半是 Cloudflare 拦了数据中心 IP（Actions runner）。");
    console.error("先用 node tools/probe-upstream.js 看状态码；确认被拦就改走自建服务器路径（DEPLOY.md 的 A 段）。");
    process.exit(1);
  }

  if (r.newEvents.length) push.enqueue(store, r.newEvents);
  const f = await push.flushQueue(store, cfg, { log });
  log(`推送：发出 ${f.sent}，失败 ${f.failed}${f.skipped ? `（${f.skipped}）` : ""}`);

  if (process.env.SNAPSHOT_PING === "1" && r.newEvents.length && cfg.wecom.webhook) {
    /* 一次跑批新增很多时，补一条汇总，避免刷屏后看不出整体情况 */
    const digest = push.buildDigest(r.newEvents.slice(-20), { hours: cfg.sync.backfillHours });
    await push.send(cfg.wecom.webhook, digest).catch(() => {});
  }

  buildStatic(STATE_DIR);
  store.save();
  log(`状态已写入 ${STATE_DIR}/db.json（事件 ${store.index.size}）`);
}

main().catch((e) => {
  console.error("跑批失败:", e.message);
  process.exit(1);
});
