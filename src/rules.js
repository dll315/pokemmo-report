"use strict";
/* 订阅规则：决定某条事件要不要推给企业微信群。
   北京时间用 UTC+8 硬算，不依赖容器时区——Actions runner 是 UTC，
   靠 TZ 环境变量会翻车，所以这里显式偏移。 */

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

function beijingParts(unixSec) {
  const d = new Date(unixSec * 1000 + BEIJING_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: String(d.getUTCMonth() + 1).padStart(2, "0"),
    d: String(d.getUTCDate()).padStart(2, "0"),
    h: String(d.getUTCHours()).padStart(2, "0"),
    mi: String(d.getUTCMinutes()).padStart(2, "0"),
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const fmtBeijing = (unixSec) => {
  const p = beijingParts(unixSec);
  return `${p.mo}-${p.d} ${p.h}:${p.mi}`;
};

function inQuietHours(nowUnix, quiet) {
  if (!quiet || !quiet.enabled) return false;
  const mins = beijingParts(nowUnix).minutesOfDay;
  const [fh, fm] = String(quiet.from || "01:00").split(":").map(Number);
  const [th, tm] = String(quiet.to || "07:00").split(":").map(Number);
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to;
}

const hit = (list, ev) =>
  (list || []).some((kw) => {
    const k = String(kw).trim().toLowerCase();
    return k && (k === String(ev.pokemon).toLowerCase() || k === String(ev.pokemonCn || "").toLowerCase());
  });

function decide(ev, cfg, nowUnix = Math.floor(Date.now() / 1000)) {
  const w = cfg.wecom;
  if (!w.webhook) return { ok: false, reason: "未配置 webhook" };
  if (!w.enabled) return { ok: false, reason: "推送已关闭" };
  if (!(w.kinds || []).includes(ev.kind)) return { ok: false, reason: `类型 ${ev.kind} 未订阅` };
  if (ev.tier < Number(w.minTier || 0)) return { ok: false, reason: `tier ${ev.tier} 低于阈值` };
  if ((w.regions || []).length && !w.regions.includes(ev.region)) return { ok: false, reason: `地区 ${ev.region} 未订阅` };
  if ((w.onlyPokemon || []).length && !hit(w.onlyPokemon, ev)) return { ok: false, reason: "不在关注名单" };
  if (hit(w.exceptPokemon || [], ev)) return { ok: false, reason: "在屏蔽名单" };
  if (inQuietHours(nowUnix, w.quietHours)) return { ok: false, reason: "免打扰时段" };
  if ((ev.expiresUnix || ev.tsUnix) <= nowUnix) return { ok: false, reason: "已过期" };
  return { ok: true };
}

module.exports = { decide, beijingParts, fmtBeijing, inQuietHours, BEIJING_OFFSET_MS };
