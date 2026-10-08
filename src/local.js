"use strict";
/* 玩家自主上报 + 管理员审核。
   防刷靠三条：只允许下拉里已知的宝可梦/地点（不接受自由文本键入新地点）、
   同一来源限频、以及默认"进待审核队列"而不是直接公开。 */

const { fromLocalReport } = require("./normalize");
const refdata = require("./refdata");
const dict = require("./dict");
const push = require("./push-wecom");
const { readConfig } = require("./config");

const RATE = { max: 6, windowMs: 10 * 60 * 1000 };
const hits = new Map();
const KINDS = new Set(["alpha", "swarm", "pheno"]);

function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  hits.set(ip, list);
  return list.length >= RATE.max;
}

/* hits 只增不清会随运行时间累积内存，跑批时顺手回收空表项 */
function sweep() {
  const now = Date.now();
  for (const [ip, list] of [...hits.entries()]) {
    const alive = list.filter((t) => now - t < RATE.windowMs);
    if (alive.length) hits.set(ip, alive);
    else hits.delete(ip);
  }
}

function recordHit(ip) {
  const list = (hits.get(ip) || []).filter((t) => Date.now() - t < RATE.windowMs);
  list.push(Date.now());
  hits.set(ip, list);
}

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n);

function validate(payload, cfg) {
  if (!cfg.publicReport) return { ok: false, error: "本站已关闭公开上报" };
  const kind = clean(payload.kind, 12);
  if (!KINDS.has(kind)) return { ok: false, error: "未知的报点类型" };
  const opts = refdata.options();
  const sp = opts.species.find((s) => s.en.toLowerCase() === clean(payload.pokemon, 40).toLowerCase());
  if (!sp) return { ok: false, error: "宝可梦名称不在图鉴里，请从下拉选择" };
  const locList = Object.values(opts.locationsByRegion).flat();
  const loc = locList.find((l) => l.en.toLowerCase() === clean(payload.location, 60).toLowerCase());
  if (!loc) return { ok: false, error: "地点名称不在数据库里，请从下拉选择" };
  if (kind === "pheno" && !opts.phenoTypes.includes(clean(payload.phenoType, 20))) {
    return { ok: false, error: "请选择正确的天气类型" };
  }
  return {
    ok: true,
    value: {
      kind,
      pokemon: sp.en,
      /* 地点决定了地区：玩家选错地区（比如把 123 号道路选成关都）以地点表为准，避免看板串区 */
      region: loc.region || clean(payload.region, 20),
      location: loc.en,
      phenoType: kind === "pheno" ? clean(payload.phenoType, 20) : "",
      note: clean(payload.note, 200),
      reporter: clean(payload.reporter, 24),
    },
  };
}

function create(store, payload, { ip = "unknown", admin = false } = {}) {
  /* 管理员带着正确口令时不受限频：反代没配 TRUST_PROXY 的情况下所有人共用一个桶，
     否则站主自己测试都会被锁住 */
  if (!admin && tooMany(ip)) return { ok: false, error: "提交太频繁，请 10 分钟后再试" };
  const cfg = readConfig();
  const v = validate(payload, cfg);
  /* 校验失败不占配额：打错一个字就被锁十分钟太苛刻 */
  if (!v.ok) return v;
  const now = Math.floor(Date.now() / 1000);
  const dup = (store.db.reports || []).find((r) => r.status === "pending" && r.kind === v.value.kind && r.pokemon === v.value.pokemon && r.location === v.value.location && now - r.createdAt < 1800);
  if (dup) {
    recordHit(ip);
    return { ok: false, error: "已经有玩家报了同一个点，正在等待审核", duplicateOf: dup.id };
  }
  recordHit(ip);

  const rep = { id: "r" + now.toString(36) + Math.random().toString(36).slice(2, 6), ...v.value, createdAt: now, status: "pending", ip };
  store.db.reports = [rep, ...(store.db.reports || [])].slice(0, 500);
  store.scheduleFlush();

  /* 关闭审核时直接入库生效，并照常走推送规则 */
  if (!cfg.reportRequireApprove) {
    const r = approve(store, rep.id);
    if (!r.ok) return r;
    return { ok: true, id: rep.id, status: "approved", autoPublished: true };
  }
  return { ok: true, id: rep.id, status: "pending" };
}

function approve(store, id) {
  const rep = (store.db.reports || []).find((r) => r.id === id);
  if (!rep) return { ok: false, error: "上报不存在" };
  const cfg = readConfig();
  const ev = fromLocalReport(rep, cfg.windows);
  const isNew = !store.index.has(ev.key);
  store.putEvents(ev);
  rep.status = "approved";
  rep.reviewedAt = Math.floor(Date.now() / 1000);
  rep.eventKey = ev.key;
  if (isNew) push.enqueue(store, [ev]);
  store.scheduleFlush();
  return { ok: true, event: ev };
}

function reject(store, id, note = "") {
  const rep = (store.db.reports || []).find((r) => r.id === id);
  if (!rep) return { ok: false, error: "上报不存在" };
  rep.status = "rejected";
  rep.reviewNote = clean(note, 100);
  rep.reviewedAt = Math.floor(Date.now() / 1000);
  store.scheduleFlush();
  return { ok: true };
}

function list(store, { status = "", limit = 50 } = {}) {
  const rows = (store.db.reports || []).filter((r) => !status || r.status === status);
  /* 待审核列表也要按当前词表补中文名：不补的话管理台看到的永远是 Breloom @ Route 119 */
  const named = rows.map((r) => dict.refreshNames(r) || r);
  return { total: rows.length, rows: named.slice(0, limit) };
}

module.exports = { create, approve, reject, list, validate, sweep };
