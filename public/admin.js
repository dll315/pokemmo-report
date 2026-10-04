"use strict";
/* 管理台脚本。口令只放 sessionStorage（关标签页即失效），每个请求带 x-admin-token 头。
   所有玩家输入用 textContent 写入 DOM，不走 innerHTML。 */

const T = { get: () => sessionStorage.getItem("adminToken") || "", set: (v) => sessionStorage.setItem("adminToken", v) };
const $ = (s) => document.querySelector(s);
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

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "x-admin-token": T.get(), ...(opts.headers || {}) },
  });
  if (res.status === 401 || res.status === 403) {
    showGate(await res.json().catch(() => ({})));
    throw new Error("口令失效");
  }
  return res.json();
}

function showGate(info = {}) {
  $("#gate").hidden = false;
  $("#ui").hidden = true;
  if (info.error) $("#gateMsg").textContent = info.error;
}
function showUI() {
  $("#gate").hidden = true;
  $("#ui").hidden = false;
}

const splitList = (s) => String(s || "").split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);

/* ---------- 渲染 ---------- */

function renderStats(state) {
  const b = state.board;
  const cards = [
    ["活动点位", b.stats.active],
    ["库存事件", b.stats.stored],
    ["上游/本站", `${b.stats.bySource.upstream} / ${b.stats.bySource.local}`],
    ["待审核", state.reports.total],
    ["推送队列", b.queue],
    ["词表地点", b.upstream.locations],
  ];
  $("#statCards").replaceChildren(
    ...cards.map(([label, value]) => el("div", { class: "stat" }, [el("b", { text: String(value) }), el("span", { text: label })]))
  );
}

function renderPending(reports) {
  const list = reports.rows || [];
  $("#pendCount").textContent = list.length ? `共 ${reports.total} 条` : "";
  if (!list.length) return $("#pendingList").replaceChildren(el("p", { class: "empty", text: "没有待审核的上报。" }));
  $("#pendingList").replaceChildren(
    ...list.map((r) =>
      el("div", { class: "pend" }, [
        el("div", {}, [
          el("b", { text: `${r.pokemon} @ ${r.location}` }),
          el("div", {
            class: "who",
            text: `${r.kind}${r.phenoType ? " / " + r.phenoType : ""} · ${r.region || "地区自动"} · ${r.reporter || "匿名"} · ${new Date(r.createdAt * 1000).toLocaleString("zh-CN", { hour12: false })}`,
          }),
          r.note ? el("div", { class: "who", text: "备注：" + r.note }) : null,
        ]),
        el("div", { class: "row" }, [
          el("button", { class: "act ok mini", type: "button", onclick: () => act("approve", { id: r.id }) }, "通过"),
          el("button", { class: "act no mini", type: "button", onclick: () => act("reject", { id: r.id, note: prompt("驳回原因（可留空）") || "" }) }, "驳回"),
        ]),
      ])
    )
  );
}

function renderConfig(cfg) {
  const w = cfg.wecom;
  $("#webhook").value = "";
  $("#hookHint").textContent = w.webhookSet ? `已保存 webhook ${w.webhookHint}（若用环境变量注入，这里改动不生效）` : "尚未配置 webhook";
  $("#maxPerTick").value = w.maxPerTick;
  $("#minTier").value = w.minTier;
  $("#pushEnabled").checked = !!w.enabled;
  $("#kindAlpha").checked = (w.kinds || []).includes("alpha");
  $("#kindSwarm").checked = (w.kinds || []).includes("swarm");
  $("#kindPheno").checked = (w.kinds || []).includes("pheno");
  $("#onlyPokemon").value = (w.onlyPokemon || []).join(", ");
  $("#exceptPokemon").value = (w.exceptPokemon || []).join(", ");
  $("#regions").value = (w.regions || []).join(", ");
  $("#quietEnabled").checked = !!(w.quietHours || {}).enabled;
  $("#quietFrom").value = (w.quietHours || {}).from || "01:00";
  $("#quietTo").value = (w.quietHours || {}).to || "07:00";
  $("#publicReport").checked = !!cfg.publicReport;
  $("#requireApprove").checked = !!cfg.reportRequireApprove;
  $("#interval").value = cfg.sync.intervalMinutes;
  $("#backfill").value = cfg.sync.backfillHours;
  $("#retention").value = cfg.sync.retentionDays;
  $("#winAlpha").value = cfg.windows.alphaMinutes;
  $("#winSwarm").value = cfg.windows.swarmMinutes;
  $("#newToken").placeholder = cfg.adminTokenSet ? "已设置，留空不修改" : "未设置！请立刻设定";
}

function renderLog(meta) {
  const rows = (meta.syncLog || []).slice().reverse().slice(0, 20);
  $("#logTable").replaceChildren(
    el("tr", {}, ["时间", "耗时", "Alpha", "群蜂", "裁剪", "错误"].map((h) => el("th", { text: h }))),
    ...rows.map((r) =>
      el("tr", {}, [
        new Date(r.at).toLocaleString("zh-CN", { hour12: false }),
        `${r.ms || 0}ms`,
        String(r.alphaAdded ?? ""),
        String(r.swarmAdded ?? ""),
        String(r.pruned ?? ""),
        r.error || "",
      ].map((c) => el("td", { text: c })))
    )
  );
  $("#metaHint").textContent = `游标 alpha=${meta.cursors.alpha} swarm=${meta.cursors.swarm} · 上轮同步 ${meta.lastSyncAt || "—"}${meta.lastSyncError ? " · 异常：" + meta.lastSyncError : ""}`;
}

async function refresh() {
  const state = await api("/api/admin/state");
  renderStats(state);
  renderPending(state.reports);
  renderConfig(state.config);
  renderLog(state.meta);
  showUI();
  return state;
}

/* ---------- 动作 ---------- */

async function act(endpoint, body) {
  const r = await api(`/api/admin/${endpoint}`, { method: "POST", body: JSON.stringify(body || {}) });
  if (r.error) return toast(r.error);
  if (endpoint === "test-push") return toast(r.errcode === 0 ? "测试消息已送达企业微信群" : `发送失败：${r.errmsg}`);
  if (endpoint === "sync") return toast(`同步完成：新增 ${r.added} 条${r.errors && r.errors.length ? " / " + r.errors.join(";") : ""}`);
  if (endpoint === "flush") return toast(`队列发送 ${r.sent} 条，失败 ${r.failed} 条`);
  if (endpoint === "reload-dict") return toast("词表已重载");
  await refresh();
  return r;
}

function collectConfig() {
  const kinds = [];
  if ($("#kindAlpha").checked) kinds.push("alpha");
  if ($("#kindSwarm").checked) kinds.push("swarm");
  if ($("#kindPheno").checked) kinds.push("pheno");
  const patch = {
    enabled: $("#pushEnabled").checked,
    kinds,
    onlyPokemon: splitList($("#onlyPokemon").value),
    exceptPokemon: splitList($("#exceptPokemon").value),
    regions: splitList($("#regions").value),
    minTier: Number($("#minTier").value || 0),
    maxPerTick: Number($("#maxPerTick").value || 4),
    quietHours: { enabled: $("#quietEnabled").checked, from: $("#quietFrom").value || "01:00", to: $("#quietTo").value || "07:00" },
    publicReport: $("#publicReport").checked,
    reportRequireApprove: $("#requireApprove").checked,
    sync: {
      intervalMinutes: Number($("#interval").value || 2),
      backfillHours: Number($("#backfill").value || 48),
      retentionDays: Number($("#retention").value || 7),
    },
    windows: { alphaMinutes: Number($("#winAlpha").value || 75), swarmMinutes: Number($("#winSwarm").value || 25) },
  };
  const hook = $("#webhook").value.trim();
  if (hook === "__clear__" || hook) patch.webhook = hook;
  const nt = $("#newToken").value.trim();
  if (nt) patch.adminToken = nt;
  return patch;
}

async function saveAll() {
  const typedToken = $("#newToken").value.trim();
  const r = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(collectConfig()) });
  if (r.error) return toast(r.error);
  $("#newToken").value = "";
  $("#saveMsg").textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  /* 换了口令就切到新口令，否则下一次请求会 401 又被踢回登录页 */
  if (typedToken) T.set(typedToken);
  await refresh();
}

/* ---------- 启动 ---------- */

function bind() {
  $("#loginBtn").addEventListener("click", () => {
    T.set($("#tokenInput").value.trim());
    refresh().then(() => toast("已进入管理台")).catch(() => {});
  });
  $("#tokenInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#loginBtn").click());
  $("#logoutBtn").addEventListener("click", () => {
    sessionStorage.removeItem("adminToken");
    showGate();
  });
  $("#syncBtn").addEventListener("click", () => act("sync", {}));
  $("#testBtn").addEventListener("click", () => act("test-push", {}));
  $("#flushBtn").addEventListener("click", () => act("flush", {}));
  $("#reloadBtn").addEventListener("click", () => act("reload-dict", {}));
  $("#refreshBtn").addEventListener("click", () => refresh().then(() => toast("已刷新")));
  $("#saveBtn").addEventListener("click", saveAll);
}

if (T.get()) refresh().catch(() => {});
else showGate();
bind();
