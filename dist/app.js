"use strict";
/* 玩家端交互：轮询看板、倒计时、筛选、报点表单、图鉴参考。
   全部用 DOM API 建节点，不用 innerHTML 拼接玩家输入，避免上报备注里的 XSS。 */

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const REFRESH_MS = 30000;
/* 静态快照模式（GitHub Pages + Actions）：没有后端，读同目录的 data.json，
   筛选在浏览器里做，上报和管理入口直接隐藏。 */
const STATIC = !!window.__STATIC__;

const state = { board: null, options: null, tab: "board", region: "", q: "", staticCache: null };

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  return n;
};

/* ---------- 时间 ---------- */

const beijingDate = (unixSec) => new Date(unixSec * 1000 + BEIJING_OFFSET);
const hhmm = (unixSec) => {
  const d = beijingDate(unixSec);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const hhmmss = (unixSec) => {
  const d = beijingDate(unixSec);
  return `${hhmm(unixSec)}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
};
function humanLeft(seconds) {
  if (seconds <= 0) return "已到点";
  const m = Math.floor(seconds / 60);
  if (m < 1) return `${seconds} 秒`;
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

/* ---------- 看板 ---------- */

function spriteNode(ev) {
  const cn = ev.pokemonCn || ev.pokemon || "?";
  const badge = () => el("span", { class: "sprite badge", text: String(cn).slice(0, 1), title: cn });
  if (!ev.natdex) return badge();
  const img = el("img", { class: "sprite", src: `/assets/sprites/${ev.natdex}.gif`, alt: "", loading: "lazy" });
  /* 图是可选装饰：gif 没有就试 png，都没有换成中文名首字徽标 */
  img.addEventListener("error", () => {
    if (!img.dataset.tried) {
      img.dataset.tried = "1";
      img.src = `/assets/sprites/${ev.natdex}.png`;
    } else img.replaceWith(badge());
  });
  return img;
}

/* 术语查询：招式/特性/秘传/天气；取不到就原样显示英文 */
function TERM(cat, en) {
  const map = ((state.options || {}).terms || {})[cat];
  if (!map || !en) return null;
  return map[String(en).trim().toLowerCase()] || null;
}
const pair = (cat, en) => {
  const cn = TERM(cat, en);
  return cn && cn !== en ? `${cn}（${en}）` : String(en || "");
};
const conceptOf = (k) => (((state.options || {}).concepts || {})[k] || { alpha: "Alpha", swarm: "Swarm", pheno: "Pheno" }[k]);

/* "去这个点要准备什么"——需求索引由后端从上游静态表算好 */
function reqBlock(ev) {
  const r = ev.req;
  if (!r) return null;
  const kids = [];
  const hms = (r.hmsCn || []).map((x) => (x.cn && x.cn !== x.en ? `${x.cn}（${x.en}）` : x.en)).filter(Boolean);
  if (hms.length) kids.push(el("span", { class: "req need", text: "需要：" + hms.join(" / ") }));
  if (r.note) kids.push(el("span", { class: "req", text: r.note }));
  if (r.specific) kids.push(el("span", { class: "req", text: "位置：" + r.specific }));
  const warn = (r.notes || []).filter(Boolean).slice(0, 2);
  if (warn.length) kids.push(el("span", { class: "req warn", text: warn.join(" · ") }));
  if (r.map) kids.push(el("a", { class: "req maplink", href: r.map, target: "_blank", rel: "noopener nofollow", text: "点位地图" }));
  return kids.length ? el("div", { class: "reqs" }, kids) : null;
}

function nameBlock(ev) {
  const cn = ev.pokemonCn || ev.pokemon;
  const kids = [el("span", { class: "cn", text: cn })];
  if (ev.pokemonCn) kids.push(el("span", { class: "en", text: ev.pokemon }));
  return el("div", { class: "names" }, kids);
}

function placeBlock(ev) {
  const kids = [el("span", { class: "loc", text: ev.locationCn || ev.location })];
  if (ev.locationCn && ev.locationCn !== ev.location) kids.push(el("span", { class: "locsub", text: ev.location }));
  const meta = [];
  if (ev.regionCn || ev.region) meta.push(`${ev.regionCn || ev.region}`);
  if (ev.phenoType) meta.push(pair("concepts", ev.phenoType) || ev.phenoType);
  if (ev.tier) meta.push(`tier ${ev.tier}`);
  if (ev.source === "local") meta.push("玩家上报");
  if (meta.length) kids.push(el("span", { class: "meta", text: meta.join(" · ") }));
  if (ev.note) kids.push(el("span", { class: "note", text: ev.note }));
  const req = reqBlock(ev);
  if (req) kids.push(req);
  return el("div", { class: "place" }, kids);
}

function timeBlock(ev) {
  const left = Math.max(0, (ev.expiresUnix || ev.tsUnix) - state.board.now) ;
  return el("div", { class: "time" }, [
    el("span", { class: "left", text: humanLeft(left), "data-left": String(ev.expiresUnix || ev.tsUnix) }),
    el("span", { class: "when", text: `报出 ${hhmm(ev.tsUnix)} · 失效 ${hhmm(ev.expiresUnix || ev.tsUnix)}` }),
  ]);
}

/* 上游数据是众包的，链接只认 http(s)，避免 javascript: 之类的伪链接 */
const safeUrl = (u) => (/^https?:\/\/\S+/.test(String(u || "")) ? u : null);

function linkBlock(ev) {
  const href = safeUrl(ev.upstreamUrl);
  return el("div", { class: "act" }, [href ? el("a", { href, target: "_blank", rel: "noopener nofollow", text: "上游" }) : null]);
}

/* 静态模式下服务端不参与筛选，只能在前端做 */
function pickRows(b, kind) {
  let rows = b[kind] || [];
  if (!STATIC) return rows;
  if (state.region) rows = rows.filter((e) => e.region === state.region);
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((e) => `${e.pokemon} ${e.pokemonCn || ""} ${e.location} ${e.locationCn || ""}`.toLowerCase().includes(q));
  }
  return rows;
}

function renderBoard() {
  const b = state.board;
  if (!b) return;
  $("#emptyNotice").hidden = b.stats.active > 0;
  for (const kind of ["alpha", "swarm", "pheno"]) {
    const rows = pickRows(b, kind);
    $(`#count-${kind}`).textContent = rows.length;
    const ul = $(`#list-${kind}`);
    ul.replaceChildren(
      ...rows.map((ev) =>
        el("li", { class: `item ${kind} ${ev.source}` }, [
          spriteNode(ev),
          nameBlock(ev),
          placeBlock(ev),
          timeBlock(ev),
          linkBlock(ev),
        ])
      )
    );
  }
  $("#slotChip").textContent = b.slots.current
    ? `时段 ${b.slots.current.index} · 剩 ${humanLeft(b.slots.current.end - b.now)}`
    : b.slots.inGap
    ? `空档 · 下段 ${hhmm(b.slots.next.start)}`
    : "时段 --";
  $("#syncChip").textContent = b.lastSyncError ? `同步异常：${b.lastSyncError}` : `同步 ${new Date(b.lastSyncAt || Date.now()).toLocaleTimeString("zh-CN", { hour12: false })}`;
  renderSlots(b.slots, b.now);
}

function renderSlots(slots, now) {
  const curIndex = slots.current ? slots.current.index : -1;
  const table = $("#slotTable");
  table.replaceChildren(
    ...slots.list.map((s) =>
      el("tr", { class: s.index === curIndex ? "cur" : "" }, [
        el("td", { text: `第 ${s.index} 段` }),
        el("td", { text: `${hhmm(s.start)} → ${hhmm(s.end)}` }),
        el("td", { text: `UTC ${s.utc}` }),
        el("td", { text: s.index === curIndex ? "进行中" : s.end < now ? "已结束" : `${humanLeft(s.start - now)}后开始` }),
      ])
    )
  );
}

/* 每秒只更新剩余时间文本，不重建节点 */
function tickCountdown() {
  const now = Math.floor(Date.now() / 1000);
  document.querySelectorAll("[data-left]").forEach((n) => {
    n.textContent = humanLeft(Math.max(0, Number(n.getAttribute("data-left")) - now));
  });
  $("#clock").textContent = `北京时间 ${hhmmss(now)}`;
}

async function loadBoard() {
  try {
    if (STATIC) {
      const j = await (await fetch("data.json", { cache: "no-store" })).json();
      state.staticCache = j;
      state.board = j.board;
      if (!state.options) {
        state.options = j.options;
        applyOptions();
        fillFormRegions();
      }
      renderBoard();
      applyTerms(j.windows);
      return;
    }
    const p = new URLSearchParams();
    if (state.region) p.set("region", state.region);
    if (state.q) p.set("q", state.q);
    const r = await fetch("/api/board?" + p.toString(), { cache: "no-store" });
    state.board = await r.json();
    renderBoard();
  } catch (e) {
    $("#syncChip").textContent = "看板加载失败，重试中…";
  }
}

/* ---------- 筛选与选项 ---------- */

function applyOptions() {
  const o = state.options;
  if (!o) return;
  const regions = o.regions.map((r) => el("option", { value: r.en, text: r.cn ? `${r.cn}（${r.en}）` : r.en }));
  $("#fRegion").append(el("option", { value: "", text: "全部地区" }), ...regions);
  $("#refRegion").append(...regions.map((n) => n.cloneNode(true)));
  window.setTimeout(fillRefLocations, 0);
}

function fillFormRegions() {
  const o = state.options;
  $("#rRegion").replaceChildren(el("option", { value: "", text: "自动按地点判定" }), ...o.regions.map((r) => el("option", { value: r.en, text: r.cn ? `${r.cn}（${r.en}）` : r.en })));
  $("#rPheno").replaceChildren(el("option", { value: "", text: "选择天气" }), ...o.phenoTypes.map((t) => el("option", { value: t, text: pair("concepts", t) || t })));
  fillFormLocations();
}

function formLocations() {
  const o = state.options;
  const region = $("#rRegion").value;
  const bucket = region ? o.locationsByRegion[region] || [] : Object.values(o.locationsByRegion).flat();
  return bucket;
}

function fillFormLocations() {
  $("#locList").replaceChildren(
    ...formLocations().map((l) => el("option", { value: l.en, label: l.cn || "" }))
  );
  $("#pokeList").replaceChildren(...state.options.species.map((s) => el("option", { value: s.en, label: s.cn || "" })));
}

function fillRefLocations() {
  const sel = $("#refLocation");
  const region = $("#refRegion").value;
  const bucket = region ? state.options.locationsByRegion[region] || [] : Object.values(state.options.locationsByRegion).flat();
  sel.replaceChildren(...bucket.map((l) => el("option", { value: l.en, text: l.cn ? `${l.cn}（${l.en}）` : l.en })));
  renderRef();
}

/* ---------- 图鉴参考 ---------- */

function locationData(loc) {
  if (STATIC) {
    const map = (state.staticCache && state.staticCache.refLocations) || {};
    return Promise.resolve({ name: loc, detail: map[loc] || {} });
  }
  return fetch("/api/ref/location?name=" + encodeURIComponent(loc)).then((r) => r.json());
}

function renderRef() {
  const loc = $("#refLocation").value;
  if (!loc) return $("#refBody").replaceChildren(el("p", { class: "hint", text: "先选一个地点。" }));
  locationData(loc).then((data) => {
    const d = data.detail || {};
    const col = (title, rows, kind) =>
      el("div", { class: "refcol" }, [
        el("h3", { text: title }),
        rows.length
          ? el("ul", {}, rows.map((x) => liForRef(x, kind)))
          : el("p", { class: "hint", text: "该地点没有此类点位。" }),
      ]);
    $("#refBody").replaceChildren(
      el("div", { class: "refgrid" }, [
        col("Alpha 点位", d.alpha || [], "alpha"),
        col("群蜂点位", d.swarm || [], "swarm"),
        col("特异天气", d.pheno || [], "pheno"),
      ])
    );
  });
}

function cnList(en, cn) {
  return (en || []).map((e, i) => (cn && cn[i] && cn[i] !== e ? `${cn[i]}（${e}）` : e));
}

function liForRef(x, kind) {
  if (kind === "pheno") {
    const typeLabel = x.typeCn && x.typeCn !== x.type ? `${x.typeCn}（${x.type}）` : x.type;
    return el("li", {}, [
      el("b", { text: typeLabel }),
      el("span", { text: (x.pokemon || []).map((p) => { const sp = state.options.species.find((s) => s.en.toLowerCase() === String(p).toLowerCase()); return sp && sp.cn ? `${sp.cn}（${p}）` : p; }).join("、") }),
      x.hms && x.hms.length ? el("em", { text: "需要：" + cnList(x.hms, x.hmsCn).join(" / ") }) : null,
      (x.notes || []).length ? el("span", { class: "warn", text: x.notes.join(" · ") }) : null,
    ]);
  }
  const sp = state.options.species.find((s) => s.en.toLowerCase() === String(x.name).toLowerCase());
  const kids = [
    el("b", { text: (sp && sp.cn) || x.name }),
    el("span", { class: "en", text: x.name }),
    x.HMs && x.HMs.length ? el("em", { text: "需要：" + cnList(x.HMs, x.hmsCn).join(" / ") }) : null,
    x.Moveset && x.Moveset.length ? el("span", { class: "moves", text: "招式：" + cnList(x.Moveset, x.movesetCn).join("、") }) : null,
    x.Ability ? el("span", { class: "moves", text: "特性：" + (x.abilityCn && x.abilityCn !== x.Ability ? `${x.abilityCn}（${x.Ability}）` : x.Ability) }) : null,
    x["Egg Group"] && x["Egg Group"].length ? el("span", { class: "moves", text: "蛋组：" + cnList(x["Egg Group"], x.eggGroupsCn).join("、") }) : null,
    x.locationNoteCn ? el("span", { class: "moves", text: x.locationNoteCn }) : null,
    (x.notesCn || []).length ? el("span", { class: "warn", text: x.notesCn.join(" · ") }) : null,
    x.Tier !== undefined ? el("span", { class: "tier", text: `tier ${x.Tier}` }) : null,
  ];
  return el("li", {}, kids);
}

/* ---------- 报点 ---------- */

function rememberedReports() {
  try {
    return JSON.parse(localStorage.getItem("reports") || "[]");
  } catch (e) {
    return [];
  }
}

function renderMyReports() {
  const list = rememberedReports();
  $("#myReports").replaceChildren(
    ...list.map((r) =>
      el("li", {}, [
        el("span", { class: "st", text: r.status || "已提交" }),
        el("b", { text: `${r.pokemon} @ ${r.location}` }),
        el("span", { class: "when", text: new Date(r.at).toLocaleString("zh-CN", { hour12: false }) }),
        r.message ? el("em", { text: r.message }) : null,
      ])
    )
  );
  if (!list.length) $("#myReports").replaceChildren(el("li", { class: "hint", text: "这台设备还没有提交记录。" }));
}

function remember(entry) {
  const list = [entry, ...rememberedReports()].slice(0, 20);
  localStorage.setItem("reports", JSON.stringify(list));
  renderMyReports();
}

async function submitReport(ev) {
  ev.preventDefault();
  const msg = $("#reportMsg");
  msg.className = "msg";
  msg.textContent = "提交中…";
  const body = {
    kind: $("#rKind").value,
    region: $("#rRegion").value,
    location: $("#rLocation").value.trim(),
    pokemon: $("#rPokemon").value.trim(),
    phenoType: $("#rPheno").value,
    reporter: $("#rReporter").value.trim(),
    note: $("#rNote").value.trim(),
  };
  try {
    const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok) {
      msg.textContent = j.autoPublished ? "已提交并直接上看板" : "已提交，等待管理员审核";
      msg.classList.add("good");
      $("#reportForm").reset();
      syncFormState();
      remember({ ...entryFrom(body), at: Date.now(), status: j.autoPublished ? "已发布" : "待审核" });
      loadBoard();
    } else {
      msg.textContent = j.error || "提交失败";
      msg.classList.add("bad");
      remember({ ...entryFrom(body), at: Date.now(), status: "被拒", message: j.error });
    }
  } catch (e) {
    msg.textContent = "网络错误：" + e.message;
    msg.classList.add("bad");
  }
}

const entryFrom = (b) => ({ pokemon: b.pokemon, location: b.location, kind: b.kind });

function syncFormState() {
  const isPheno = $("#rKind").value === "pheno";
  $("#rPheno").disabled = !isPheno;
  fillFormLocations();
}

/* ---------- 标签页 ---------- */

function showTab(name) {
  state.tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const id of ["board", "report", "ref"]) $("#tab-" + id).hidden = id !== name;
  if (name === "report" && !$("#locList").children.length) fillFormRegions();
  location.hash = name;
}

/* ---------- 启动 ---------- */

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });
}

/* 列标题与时效提示都跟着词表和配置走，不在 HTML 里写死 */
function labelFor(kind, en) {
  const cn = conceptOf(kind === "alpha" ? "alpha" : kind === "swarm" ? "swarm" : "pheno");
  return cn && cn !== en ? `${cn}（${en}）` : en;
}
function applyTerms(windows) {
  for (const kind of ["alpha", "swarm", "pheno"]) {
    const l = $(`#label-${kind}`);
    if (l) l.textContent = labelFor(kind, { alpha: "Alpha", swarm: "Swarm", pheno: "Pheno" }[kind]);
  }
  if (windows) {
    $(`#hint-alpha`).textContent = `报出后 ${windows.alphaMinutes || 75} 分钟内有效`;
    $(`#hint-swarm`).textContent = `报出后 ${windows.swarmMinutes || 25} 分钟内有效`;
  }
  const h = $("#hint-pheno");
  if (h && TERM("concepts", "Pheno")) h.textContent = `上游无${conceptOf("pheno")}流水，仅本站玩家上报`;
}

async function boot() {
  initTheme();
  if (STATIC) {
    /* 静态快照没有后端，上报入口直接拿掉 */
    const t = document.querySelector('.tab[data-tab="report"]');
    if (t) t.remove();
  } else {
    try {
      state.options = await (await fetch("/api/ref/options", { cache: "no-store" })).json();
      applyOptions();
      fillFormRegions();
    } catch (e) {
      console.error("选项加载失败", e);
    }
    try {
      const pub = await (await fetch("/api/config/public", { cache: "no-store" })).json();
      applyTerms(pub.windows);
    } catch (e) {
      applyTerms(null);
    }
  }
  await loadBoard();
  renderMyReports();
  tickCountdown();
  setInterval(tickCountdown, 1000);
  setInterval(loadBoard, REFRESH_MS);

  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  $("#refreshBtn").addEventListener("click", loadBoard);
  $("#fRegion").addEventListener("change", (e) => ((state.region = e.target.value), loadBoard()));
  let qTimer;
  $("#fQuery").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => ((state.q = e.target.value.trim()), loadBoard()), 300);
  });
  $("#reportForm").addEventListener("submit", submitReport);
  $("#rKind").addEventListener("change", syncFormState);
  $("#rRegion").addEventListener("change", fillFormLocations);
  $("#refRegion").addEventListener("change", fillRefLocations);
  $("#refLocation").addEventListener("change", renderRef);

  showTab((location.hash || "#board").slice(1));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && loadBoard());
}

boot();
