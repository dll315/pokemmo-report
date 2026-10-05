"use strict";
/* 企业微信机器人推送。
   - 一条事件一张卡片，保证时效；但每个 tick 最多发 maxPerTick 条，
     企业微信群机器人限速约 20 条/分钟，回填几千条时会直接被打回。
   - 发送失败不推进队列，事件留在 db.queue 里下个 tick 重试，重试 5 次后丢弃。 */

const { request } = require("./net");
const { fmtBeijing, decide } = require("./rules");
const { slots } = require("./slots");
const dict = require("./dict");
const refdata = require("./refdata");

/* 标题用社区通用术语（上游语言包：Alpha→头目、Swarm→大量出现(明雷)、Pheno→奇遇），
   括注英文原名，避免老玩家对不上号 */
const KIND_EMOJI = { alpha: "🔴", swarm: "🐝", pheno: "🌀" };
function kindTitle(kind) {
  const en = { alpha: "Alpha", swarm: "Swarm", pheno: "Pheno" }[kind] || "Alpha";
  const cn = dict.concept(en);
  return cn && cn !== en ? `${cn} ${en}` : en;
}

const byteLen = (s) => Buffer.byteLength(s, "utf8");
const LIMIT = 4096;

function displayName(ev) {
  return ev.pokemonCn ? `${ev.pokemonCn}（${ev.pokemon}）` : ev.pokemon;
}
function placeName(ev) {
  return ev.locationCn ? `${ev.locationCn}${ev.location && ev.locationCn !== ev.location ? `（${ev.location}）` : ""}` : ev.location;
}
function regionName(ev) {
  return ev.regionCn ? `${ev.regionCn}（${ev.region}）` : ev.region;
}

function remainingText(ev, nowUnix) {
  const left = (ev.expiresUnix || ev.tsUnix) - nowUnix;
  if (left <= 0) return "已到点";
  const m = Math.round(left / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`;
}

/* 去之前要带什么：秘传兽需求，来自上游静态表 */
function hmsText(req) {
  if (!req || !req.hms || !req.hms.length) return "";
  return req.hms.map((h) => dict.termPair("hms", h) || h).filter(Boolean).join(" / ");
}

/* 推送上下文：本波时段、这一波的头目统计、同地点还有谁。
   一个 tick 算一遍传给每张卡片 —— 玩家判断"现在值不值得赶过去"靠的就是这几个数。 */
function pushContext(store, nowUnix = Math.floor(Date.now() / 1000)) {
  const s = slots(nowUnix);
  const alpha = store.events({ activeOnly: true, limit: 500 }).rows.filter((e) => e.kind === "alpha");
  const byPlace = new Map();
  for (const e of alpha) {
    const k = String(e.location || "").toLowerCase();
    if (!byPlace.has(k)) byPlace.set(k, []);
    byPlace.get(k).push(e);
  }
  return {
    slot: s.current,
    next: s.next,
    inGap: s.inGap,
    waveTotal: alpha.length,
    waveHigh: alpha.filter((e) => Number(e.tier) >= 4).length,
    samePlace: (ev) => (byPlace.get(String(ev.location || "").toLowerCase()) || []).filter((e) => e.key !== ev.key),
  };
}

const hhmm = (unixSec) => String(fmtBeijing(unixSec)).slice(-5);

function buildMessage(ev, { nowUnix = Math.floor(Date.now() / 1000), ctx = null } = {}) {
  const req = ev.req || refdata.requirementFor(ev) || {};
  const isAlpha = ev.kind === "alpha";
  const others = isAlpha && ctx ? ctx.samePlace(ev) : [];
  const lines = [
    `**${KIND_EMOJI[ev.kind] || "🔴"} ${kindTitle(ev.kind)}｜${displayName(ev)}**`,
    `地点：<font color="info">${placeName(ev)}</font>`,
    ev.region ? `地区：${regionName(ev)}` : "",
    req.typesCn && req.typesCn.length ? `属性：${req.typesCn.join(" / ")}` : "",
    req.abilityCn ? `特性：${req.abilityCn}` : "",
    req.movesetCn && req.movesetCn.length ? `配招：${req.movesetCn.slice(0, 6).join("、")}` : "",
    `剩余：<font color="warning">约 ${remainingText(ev, nowUnix)}</font>（${fmtBeijing(ev.expiresUnix || ev.tsUnix)} 北京时间消失）`,
    isAlpha && ctx && ctx.slot ? `本波：第 ${ctx.slot.index} 波 ${hhmm(ctx.slot.start)}–${hhmm(ctx.slot.end)}（北京时间）` : "",
    isAlpha && ctx && ctx.inGap && ctx.next ? `现在在两波之间：下一波 ${hhmm(ctx.next.start)} 开始` : "",
    `报出：${fmtBeijing(ev.tsUnix)}`,
    ev.phenoType ? `天气：${dict.termPair("concepts", ev.phenoType)}` : "",
    hmsText(req) ? `需要：${hmsText(req)}` : "",
    req.specific ? `位置：${req.specific}` : "",
    (req.notes || []).filter(Boolean).length ? `小怪警告：${req.notes.filter(Boolean).slice(0, 2).join(" · ")}` : "",
    ev.tier ? `价值 tier：${ev.tier}${req.valuable ? "　<font color=\"warning\">★ 上游标记为有价值</font>" : ""}` : "",
    isAlpha && ctx && ctx.waveTotal ? `本波共 ${ctx.waveTotal} 个头目，其中 tier≥4 的 ${ctx.waveHigh} 个` : "",
    others.length ? `同点还有：${others.slice(0, 3).map(displayName).join("、")}${others.length > 3 ? ` 等 ${others.length} 个` : ""}` : "",
    ev.source === "local" ? `来源：玩家上报${ev.reporter ? `（${ev.reporter}）` : ""}` : "",
    ev.note ? `备注：${String(ev.note).slice(0, 80)}` : "",
    req.map ? `[点位地图](${req.map})` : "",
    ev.upstreamUrl ? `[查看上游原始报点](${ev.upstreamUrl})` : "",
    `<font color="comment">数据来自 Alphapedia 众包 · 本站镜像</font>`,
  ].filter(Boolean);
  let content = lines.join("\n");
  while (byteLen(content) > LIMIT) content = content.slice(0, content.length - 40);
  return { msgtype: "markdown", markdown: { content } };
}

function buildDigest(events, meta = {}) {
  const head = `**📊 报点汇总（近 ${meta.hours || 24} 小时）**`;
  const rows = events.slice(0, 30).map((ev) => `· ${displayName(ev)} @ ${placeName(ev)} — ${remainingText(ev, meta.nowUnix || Math.floor(Date.now() / 1000))}`);
  let content = [head, ...rows, `<font color="comment">共 ${events.length} 条有效点位</font>`].join("\n");
  while (byteLen(content) > LIMIT) content = content.slice(0, content.length - 40);
  return { msgtype: "markdown", markdown: { content } };
}

/* 企业微信群机器人的常见错误码翻成人话：不给这一层，界面上就只剩一句英文 errmsg */
const HINTS = {
  93000: "webhook 地址里的 key 不对，或机器人已被移出群——去群设置里重新复制机器人地址",
  95000: "请求太频繁，机器人被临时限流",
  45009: "企业微信限流（约 20 条/分钟）——不是配置错了，等一分钟再点一次",
  40008: "消息类型不被支持（本程序只发 markdown）",
  40058: "消息内容为空或不合法",
  40007: "消息体结构不对",
  44002: "请求体为空或不是 JSON",
  44013: "消息内容里的链接不合法",
};

function explain(r) {
  if (!r) return "没有收到响应";
  if (r.errcode === 0) return "";
  const code = Number(r.errcode);
  if (code === -1) return /超时|timeout|ETIMEDOUT|ECONN|EAI_AGAIN|socket|ENOTFOUND|getaddrinfo/i.test(String(r.errmsg))
    ? "连不上机器人地址：查服务器出网、DNS 与防火墙（企业微信的域名是 qyapi.weixin.qq.com）" : String(r.errmsg || "发送失败");
  return HINTS[code] || `企业微信返回 errcode ${code}`;
}

async function send(webhook, payload) {
  if (!/^https?:\/\//.test(webhook)) { const e = new Error("webhook 地址不合法（要 https:// 开头）"); e.code = "EBADHOOK"; throw e; }
  const res = await request(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    retries: 2,
    timeoutMs: 12000,
  });
  const body = res.json || {};
  const errcode = body.errcode ?? -1;
  const errmsg = body.errmsg || res.text.slice(0, 120);
  return { httpStatus: res.status, errcode, errmsg, hint: explain({ errcode, errmsg }) };
}

/* ---------- 待发队列 ---------- */

function enqueue(store, events, { maxAgeSeconds = 2 * 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const q = store.db.queue || (store.db.queue = []);
  const seen = new Set(q.map((i) => i.key));
  let added = 0;
  for (const ev of [].concat(events)) {
    /* 首轮回填会一次捞回几天前的历史点，超过 maxAgeSeconds 的不进队列，否则群会被刷屏 */
    if (now - ev.tsUnix > maxAgeSeconds) continue;
    if (seen.has(ev.key)) continue;
    q.push({ key: ev.key, kind: ev.kind, tries: 0 });
    added++;
  }
  if (q.length > 300) q.splice(0, q.length - 300);
  if (added) store.scheduleFlush();
  return added;
}

/* 一条点位要送达到"每一条启用的连接"，所以队列项上记的是 sentTo（已送达的连接 id）。
   全部送达才出队；只送达到一部分的留着重试，但最多 5 轮，避免一条坏连接把队列卡死。 */
async function flushQueue(store, cfg, { log = () => {} } = {}) {
  const q = store.db.queue || [];
  if (!q.length) return { sent: 0, failed: 0 };
  const w = cfg.wecom;
  if (!w.enabled) return { sent: 0, failed: 0, skipped: "总开关已关闭" };
  const targets = (w.targets || []).filter((t) => t.enabled && t.webhook);
  if (!targets.length) return { sent: 0, failed: 0, skipped: "没有启用中的连接" };

  const stats = (store.db.meta.pushStats = store.db.meta.pushStats || {});
  const ctx = pushContext(store);
  const cap = Number(w.maxPerTick || 4);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < Math.min(cap, q.length); ) {
    const item = q[i];
    const ev = store.getEvent(item.key);
    if (!ev) {
      q.splice(i, 1);
      continue;
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const verdict = decide(ev, cfg, nowUnix);
    if (!verdict.ok) {
      /* 规则不满足或已过期：不是错误，直接丢弃 */
      q.splice(i, 1);
      continue;
    }
    item.sentTo = (item.sentTo || []).filter((id) => targets.some((t) => t.id === id));
    for (const t of targets) {
      if (item.sentTo.includes(t.id)) continue;
      let r;
      try {
        r = await send(t.webhook, buildMessage(ev, { nowUnix, ctx }));
      } catch (e) {
        r = { errcode: -1, errmsg: e.message };
      }
      const hint = r.hint || explain(r);
      if (r.errcode === 0) {
        item.sentTo.push(t.id);
        sent++;
        ev.pushedAt = nowUnix;
        stats[t.id] = { at: nowUnix, ok: true, err: "" };
        log(`推送成功[${t.name}] ${ev.kind} ${ev.pokemon} @ ${ev.location}`);
      } else {
        failed++;
        stats[t.id] = { at: nowUnix, ok: false, err: `${r.errmsg}${hint ? "｜" + hint : ""}` };
        /* 只在第一轮失败时喊一声，不然每 2 分钟刷一条同样的日志会淹掉 */
        if (!item.tries) log(`推送失败[${t.name}]（会自动重试到第 5 轮）${ev.pokemon} @ ${ev.location}: ${r.errmsg}${hint ? "｜" + hint : ""}`);
      }
      await new Promise((res) => setTimeout(res, 350));
    }
    if (item.sentTo.length >= targets.length) {
      q.splice(i, 1);
      continue;
    }
    item.tries++;
    if (item.tries >= 5) {
      q.splice(i, 1);
      log(`推送放弃（重试 5 轮）${ev.pokemon} @ ${ev.location}：${item.sentTo.length}/${targets.length} 条连接送达`);
    } else {
      i++;
    }
  }
  store.scheduleFlush();
  return { sent, failed, targets: targets.length, remaining: q.length };
}

module.exports = { buildMessage, buildDigest, send, enqueue, flushQueue, pushContext, remainingText, displayName, placeName, regionName, hmsText, kindTitle, explain };
