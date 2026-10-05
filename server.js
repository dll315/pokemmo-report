#!/usr/bin/env node
"use strict";
/* PokeMMO 报点站：静态站点 + 数据接口 + 上游同步 + 企业微信推送调度，单进程零依赖。
   node server.js [端口] [--host=0.0.0.0] [--no-scheduler]
   登录：管理台用账号 + 密码（config 的 adminUser / adminPassword，或环境变量 ADMIN_USER / ADMIN_PASSWORD）
   WECOM_WEBHOOK 优先于 data/config.json；TZ 不影响业务时间（北京时间按 UTC+8 硬算） */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { readConfig, writeConfig, masked } = require("./src/config");
const { Store } = require("./src/store");
const sync = require("./src/sync");
const push = require("./src/push-wecom");
const local = require("./src/local");
const refdata = require("./src/refdata");
const dict = require("./src/dict");
const auth = require("./src/auth");
const { fmtBeijing } = require("./src/rules");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const argv = process.argv.slice(2);
const PORT = Number(argv.find((a) => /^\d+$/.test(a))) || Number(process.env.PORT) || 3580;
const opt = (name, dft) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? dft;
const HOST = opt("host", process.env.HOST || "127.0.0.1");
const SCHEDULER = !argv.includes("--no-scheduler");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};

const store = new Store(DATA_DIR);
store.load();

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---------------- 工具 ---------------- */

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) return reject(new Error("请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/* 板报数据见 src/board.js（与静态构建共用） */
const { boardData: buildBoard } = require("./src/board");
function boardData(query = {}) {
  return buildBoard(store, query);
}

/* ---------------- 路由 ---------------- */

async function handleApi(req, res, url) {
  const cfg = readConfig();
  const isLoginFlow = url.pathname === "/api/admin/login" || url.pathname === "/api/admin/logout" || url.pathname === "/api/admin/session";
  const isAdmin = url.pathname.startsWith("/api/admin/") && !isLoginFlow;
  const session = auth.whoami(req.headers.cookie);
  if (isAdmin && !session) return send(res, 401, { error: "请先登录管理台", needLogin: true });

  /* 只读接口 */
  if (req.method === "GET") {
    if (url.pathname === "/api/board") return send(res, 200, boardData(Object.fromEntries(url.searchParams)));
    if (url.pathname === "/api/events") {
      const r = store.events({
        kind: url.searchParams.get("kind") || "",
        region: url.searchParams.get("region") || "",
        q: url.searchParams.get("q") || "",
        source: url.searchParams.get("source") || "",
        activeOnly: url.searchParams.get("active") === "1",
        limit: Number(url.searchParams.get("limit") || 200),
      });
      const rows = r.rows.map((e) => ({ ...e, req: refdata.requirementFor(e) }));
      return send(res, 200, { ...r, rows, beijingNow: fmtBeijing(Math.floor(Date.now() / 1000)) });
    }
    if (url.pathname === "/api/ref/options") return send(res, 200, refdata.options());
    if (url.pathname === "/api/ref/species") return send(res, 200, refdata.speciesDetail(url.searchParams.get("name") || ""));
    if (url.pathname === "/api/ref/location") return send(res, 200, locationInfo(url.searchParams.get("name")));
    if (url.pathname === "/api/config/public") return send(res, 200, { publicReport: cfg.publicReport, reportRequireApprove: cfg.reportRequireApprove, windows: cfg.windows });
    if (url.pathname === "/api/admin/session") return send(res, 200, { authed: !!session, user: session ? session.user : null, expiresAt: session ? new Date(session.exp).toISOString() : null });
    if (url.pathname === "/api/admin/state") {
      return send(res, 200, { config: masked(cfg), meta: store.db.meta, board: boardData(), reports: local.list(store, { status: "pending", limit: 100 }), queue: store.db.queue || [] });
    }
    if (url.pathname === "/api/admin/export") {
      return send(res, 200, { generatedAt: new Date().toISOString(), events: store.events({ activeOnly: false, limit: 5000 }).rows, board: boardData() });
    }
    if (url.pathname === "/api/admin/config") return send(res, 200, masked(cfg));
    return send(res, 404, { error: "接口不存在" });
  }

  if (req.method !== "POST" && req.method !== "PUT") return send(res, 405, { error: "方法不允许" });
  const payload = await readBody(req);

  /* 登录 / 退出：不需要已有会话 */
  if (url.pathname === "/api/admin/login") {
    const ip = clientIp(req);
    if (auth.tooMany(ip)) return send(res, 429, { error: "登录尝试太多，10 分钟后再试" });
    const r = auth.login(payload.user, payload.password, cfg);
    auth.recordAttempt(ip);
    if (!r.ok) return send(res, 401, r);
    res.setHeader("Set-Cookie", auth.cookieHeader(auth.CookieName, r.token, Math.floor(auth.TTL_MS / 1000)));
    return send(res, 200, { ok: true, user: r.user, expiresAt: new Date(Date.now() + auth.TTL_MS).toISOString() });
  }
  if (url.pathname === "/api/admin/logout") {
    auth.logout(req.headers.cookie);
    res.setHeader("Set-Cookie", auth.cookieHeader(auth.CookieName, "", 0));
    return send(res, 200, { ok: true });
  }

  /* 玩家上报 */
  if (url.pathname === "/api/report") {
    const r = local.create(store, payload, { ip: clientIp(req), admin: !!session });
    return send(res, r.ok ? 200 : 400, r);
  }

  if (!isAdmin) return send(res, 404, { error: "接口不存在" });

  if (url.pathname === "/api/admin/config") {
    const patch = {};
    if (typeof payload.adminUser === "string" && payload.adminUser.trim()) patch.adminUser = payload.adminUser.trim().slice(0, 32);
    if (payload.adminPassword === "__clear__") patch.adminPassword = "";
    else if (payload.adminPassword) patch.adminPassword = String(payload.adminPassword).slice(0, 64);
    if (typeof payload.publicReport === "boolean") patch.publicReport = payload.publicReport;
    if (typeof payload.reportRequireApprove === "boolean") patch.reportRequireApprove = payload.reportRequireApprove;

    const wecom = {};
    if (payload.webhook === "__clear__") wecom.webhook = "";
    else if (payload.webhook) wecom.webhook = String(payload.webhook).trim();
    for (const k of ["enabled", "kinds", "onlyPokemon", "exceptPokemon", "regions", "minTier", "maxPerTick", "quietHours"]) {
      if (payload[k] !== undefined) wecom[k] = payload[k];
    }
    if (Object.keys(wecom).length) patch.wecom = wecom;
    if (payload.sync) patch.sync = payload.sync;
    if (payload.windows) patch.windows = payload.windows;

    writeConfig(patch);
    /* 改过账号或密码，就让除本次之外的会话全部失效，逼别人手里那份旧 cookie 作废 */
    if (patch.adminPassword || patch.adminUser) for (const t of [...auth.sessions.keys()]) if (t !== (session && session.token)) auth.sessions.delete(t);
    return send(res, 200, { saved: true, credentialsChanged: !!(patch.adminPassword || patch.adminUser), config: masked(readConfig()) });
  }
  if (url.pathname === "/api/admin/sync") {
    const r = await sync.syncOnce(store, readConfig(), { log });
    if (r.newEvents.length) push.enqueue(store, r.newEvents);
    return send(res, 200, { ok: true, added: r.newEvents.length, perKind: r.perKind, errors: r.errors, ms: r.ms });
  }
  if (url.pathname === "/api/admin/approve") {
    const r = local.approve(store, String(payload.id || ""));
    return send(res, r.ok ? 200 : 400, r);
  }
  if (url.pathname === "/api/admin/reject") {
    const r = local.reject(store, String(payload.id || ""), String(payload.note || ""));
    return send(res, r.ok ? 200 : 400, r);
  }
  if (url.pathname === "/api/admin/test-push") {
    const cfg = readConfig();
    const hook = String(payload.webhook || "").trim() || cfg.wecom.webhook;
    if (!hook) return send(res, 200, { errcode: -1, errmsg: "未配置 webhook", hint: "先在「推送设置」里填机器人地址并保存（或部署时用 WECOM_WEBHOOK 环境变量）" });
    const sample = store.events({ activeOnly: true, limit: 1 }).rows[0];
    const msg = sample ? push.buildMessage(sample) : { msgtype: "markdown", markdown: { content: "**报点站连通性测试**\n当前没有活动点位。" } };
    let r;
    try {
      r = await push.send(hook, msg);
    } catch (e) {
      r = { errcode: -1, errmsg: e.message, hint: push.explain({ errcode: -1, errmsg: e.message }) };
    }
    log(`测试推送 → ${r.errcode === 0 ? "已送达" : "失败：" + r.errmsg + (r.hint ? "｜" + r.hint : "")}`);
    if (r.errcode === 0 && !cfg.wecom.enabled) r.hint = "这条测试发出去了，但「推送总开关」是关的，真实报点不会自动发——去推送设置里打开";
    return send(res, 200, r);
  }
  if (url.pathname === "/api/admin/flush") {
    const r = await push.flushQueue(store, readConfig(), { log });
    return send(res, 200, r);
  }
  if (url.pathname === "/api/admin/reload-dict") {
    const loaded = refdata.reload();
    dict.reload();
    return send(res, 200, { ok: !!loaded });
  }
  return send(res, 404, { error: "接口不存在" });
}

function locationInfo(name) {
  const key = String(name || "").trim();
  return { name: key, cn: dict.locationOf(key), detail: refdata.atLocation(key) };
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/admin" || p === "/admin/") p = "/admin.html";
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(PUBLIC_DIR, p);
  const rel = path.relative(PUBLIC_DIR, file);
  if (rel.startsWith("..") || rel.startsWith(".")) {
    res.writeHead(403);
    return res.end("403");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 页面不存在");
    }
    /* 图片文件名即内容（编号.png），可以放心让玩家缓存一周；页面与脚本仍然 no-cache，改了立刻生效 */
    const immutable = p.startsWith("/assets/");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=604800" : "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((e) => send(res, 400, { error: e.message || String(e) }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(req, res, url);
});

/* ---------------- 调度 ---------------- */

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cfg = readConfig();
    local.sweep();
    auth.sweep();
    const r = await sync.syncOnce(store, cfg, { log });
    if (r.newEvents.length) {
      push.enqueue(store, r.newEvents);
      log(`新增 ${r.newEvents.length} 条报点，进入推送队列`);
    }
    const f = await push.flushQueue(store, cfg, { log });
    if (f.sent || f.failed) log(`推送：成功 ${f.sent}，失败 ${f.failed}，队列剩 ${f.remaining ?? 0}`);
  } catch (e) {
    log("调度失败:", e.message);
  } finally {
    busy = false;
  }
}

server.listen(PORT, HOST, async () => {
  const cfg = readConfig();
  console.log("PokeMMO 报点站");
  console.log(`  站点     http://${HOST}:${PORT}/`);
  console.log(`  管理台   http://${HOST}:${PORT}/admin`);
  console.log(`  数据库   ${path.join(DATA_DIR, "db.json")}（${store.index.size} 条事件）`);
  if (process.env.WECOM_WEBHOOK) console.log("  推送     webhook 由环境变量注入，网页里改不会生效（环境变量优先）");
  if (!cfg.adminPassword) console.log("  ⚠ 未设置管理密码，管理台无法登录。在 data/config.json 写 adminPassword 或设环境变量 ADMIN_PASSWORD");
  else if (require("./src/config").isWeakPassword(cfg.adminPassword))
    console.log(`  ⚠ 管理密码是弱口令（当前账号 ${cfg.adminUser}）。站点是公网可访问的，建议改成 8 位以上；登录已限频 8 次/10 分钟`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && cfg.adminPassword && require("./src/config").isWeakPassword(cfg.adminPassword))
    console.log("  ⚠ 公网监听 + 弱密码，任何人猜到就能改你的推送设置；至少把密码换掉再对外");
  if (!TRUST_PROXY && (HOST === "0.0.0.0" || HOST !== "127.0.0.1"))
    console.log("  ⚠ 未设 TRUST_PROXY=1：前面有 Nginx 反代时所有玩家会共用同一个上报限流桶（6 条/10 分钟），配上反代就设这个环境变量");

  if (!store.db.meta.seededAt) {
    console.log("  首次启动：正在回填上游报点，请稍候…");
    await tick();
    store.db.meta.seededAt = new Date().toISOString();
    store.save();
    console.log(`  回填完成：${store.index.size} 条`);
  }
  if (SCHEDULER) {
    const every = Math.max(1, Number(cfg.sync.intervalMinutes || 2)) * 60000;
    console.log(`  同步     每 ${every / 60000} 分钟一次，推送队列 ${store.db.queue.length} 条`);
    setInterval(tick, every);
  } else {
    console.log("  同步     已关闭（--no-scheduler）");
  }
});

function shutdown() {
  try {
    store.save();
  } catch (e) {
    /* 退出时尽力持久化 */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
