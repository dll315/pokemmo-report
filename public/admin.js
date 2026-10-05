"use strict";
/* 管理台脚本。登录态是服务端的 HttpOnly cookie（同域请求自动带上），前端不存任何凭据。
   所有玩家输入用 textContent 写入 DOM，不走 innerHTML。 */

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
  /* 失败原因带中文解释时句子很长，按长度多留一会儿，别让人来不及看 */
  const ms = Math.min(9000, 2600 + Math.max(0, String(msg).length - 14) * 110);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401 || res.status === 403) {
    showGate(await res.json().catch(() => ({})));
    throw new Error("登录已失效，请重新登录");
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
  $("#newUser").value = "";
  $("#newToken").value = "";
  $("#newToken").placeholder = cfg.adminPasswordWeak ? "当前密码是弱口令，建议改掉" : "已设置，留空不修改";
  $("#userHint").textContent = `当前账号 ${cfg.adminUser}${cfg.adminPasswordWeak ? " · 密码是弱口令（登录已限频 8 次/10 分钟，仍建议改）" : ""}`;
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
  if (endpoint === "test-push") {
    const okText = r.errcode === 0 ? (r.hint ? `已送达，但${r.hint}` : "测试消息已送达企业微信群") : `发送失败：${r.errmsg}${r.hint ? "｜" + r.hint : ""}`;
    return toast(okText);
  }
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
  const nu = $("#newUser").value.trim();
  const np = $("#newToken").value.trim();
  if (nu) patch.adminUser = nu;
  if (np) patch.adminPassword = np;
  return patch;
}

async function saveAll() {
  const changed = $("#newUser").value.trim() || $("#newToken").value.trim();
  const r = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(collectConfig()) });
  if (r.error) return toast(r.error);
  $("#newUser").value = "";
  $("#newToken").value = "";
  $("#saveMsg").textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  /* 改过账号/密码，服务端已把旧会话作废，必须重新登录一次 */
  if (r.credentialsChanged || changed) {
    showGate({ error: "账号或密码已更新，请用新密码重新登录" });
    toast("凭据已更新，请重新登录");
    return;
  }
  await refresh();
}

/* ---------- 启动 ---------- */

function doLogin() {
  const user = $("#userInput").value.trim();
  const password = $("#passInput").value;
  $("#gateMsg").textContent = "登录中…";
  fetch("/api/admin/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        $("#gateMsg").textContent = j.error || "登录失败";
        $("#passInput").value = "";
        return;
      }
      $("#gateMsg").textContent = "";
      await refresh();
      toast(`欢迎，${j.user}`);
    })
    .catch((e) => {
      $("#gateMsg").textContent = "登录请求失败：" + e.message;
    });
}

function bind() {
  $("#loginBtn").addEventListener("click", doLogin);
  $("#passInput").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  $("#userInput").addEventListener("keydown", (e) => e.key === "Enter" && $("#passInput").focus());
  $("#logoutBtn").addEventListener("click", async () => {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    showGate();
    toast("已退出登录");
  });
  $("#syncBtn").addEventListener("click", () => act("sync", {}));
  $("#testBtn").addEventListener("click", () => act("test-push", {}));
  $("#flushBtn").addEventListener("click", () => act("flush", {}));
  $("#reloadBtn").addEventListener("click", () => act("reload-dict", {}));
  $("#refreshBtn").addEventListener("click", () => refresh().then(() => toast("已刷新")));
  $("#saveBtn").addEventListener("click", saveAll);
}

/* 先看有没有有效会话（cookie 由浏览器管），有就直接进，没有就摆登录框 */
fetch("/api/admin/session", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((s) => (s.authed ? refresh().catch(() => {}) : showGate()))
  .catch(() => showGate());
bind();
