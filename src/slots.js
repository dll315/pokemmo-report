"use strict";
/* Alpha 刷新时段：上游首页固定展示 4 段（UTC 0/6/12/18 点起，各 4 小时 45 分），
   段与段之间是 1 小时 15 分的空档。这里按天现算，避免写死字符串。 */

const SLOT_STARTS_UTC = [0, 6, 12, 18];
const SLOT_MINUTES = 285; /* 4h45m */

function dayStartUnix(unixSec) {
  const d = new Date(unixSec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

function slots(nowUnix = Math.floor(Date.now() / 1000)) {
  const base = dayStartUnix(nowUnix);
  const list = SLOT_STARTS_UTC.map((h, i) => {
    const start = base + h * 3600;
    const end = start + SLOT_MINUTES * 60;
    return { index: i + 1, start, end, utc: `${String(h).padStart(2, "0")}:00 → ${String(Math.floor(end % 86400 / 3600)).padStart(2, "0")}:${String(end % 3600 / 60).padStart(2, "0")}` };
  });
  const current = list.find((s) => nowUnix >= s.start && nowUnix < s.end) || null;
  const next = [...list].sort((a, b) => a.start - b.start).find((s) => s.start > nowUnix) || list[0];
  return { list, current, next, inGap: !current };
}

module.exports = { slots, SLOT_MINUTES };
