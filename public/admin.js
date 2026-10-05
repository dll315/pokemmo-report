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

function relTime(unix) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (d < 60) return `${d} 秒前`;
  if (d < 3600) return `${Math.floor(d / 60)} 分前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

/* 连接列表：每条机器人地址单独启用/改名/删除/测试。完整 key 不进浏览器，只显示尾号。 */
function renderHooks(w, push) {
  const list = w.targets || [];
  const stats = (push && push.stats) || {};
  const on = list.filter((t) => t.enabled).length;
  const rows = [el("tr", {}, ["名称", "地址（只显示尾号）", "启用", "最后一次发送", "操作"].map((h) => el("th", { text: h })))];
  if (!list.length) {
    rows.push(el("tr", {}, [el("td", { colspan: "5", class: "empty", text: "还没有连接：本站只更新看板，不会推送。在下面粘贴机器人地址添加。" })]));
  }
  for (const t of list) {
    const s = stats[t.id];
    const when = s ? new Date(s.at * 1000).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const cell = el("td", { class: s && !s.ok ? "no" : "", text: s ? `${s.ok ? "成功" : "失败"} ${when}（${relTime(s.at)}）${s.err ? " · " + s.err : ""}` : "还没发过" });
    rows.push(
      el("tr", {}, [
        el("td", {}, [el("b", { text: t.name }), t.locked ? el("span", { class: "en", text: "环境变量注入" }) : null]),
        el("td", {}, [el("code", { text: t.webhookHint }), t.offHost ? el("span", { class: "no", text: " 非官方域名" }) : null]),
        el("td", {}, [el("input", { type: "checkbox", ...(t.enabled ? { checked: "" } : {}), ...(t.locked ? { disabled: "" } : {}), onchange: () => toggleTarget(t) })]),
        cell,
        el("td", { class: "rowbtns" }, [
          el("button", { class: "act mini", type: "button", onclick: () => testTarget(t) }, "测试"),
          t.locked ? null : el("button", { class: "act mini", type: "button", onclick: () => renameTarget(t) }, "改名"),
          t.locked ? null : el("button", { class: "act no mini", type: "button", onclick: () => removeTarget(t) }, "删除"),
        ]),
      ])
    );
  }
  $("#hookTable").replaceChildren(...rows);
  $("#hookSummary").textContent = list.length
    ? `共 ${list.length} 条，启用 ${on} 条 · 一条点位会送达到每条启用的连接（企业微信的 20 条/分钟限速是按每个机器人算的，互不占用）`
    : "没有连接时看板照常更新，只是不推送。";
  const notes = [];
  if (list.some((t) => t.locked)) notes.push("标着「环境变量注入」的那条来自 WECOM_WEBHOOK，改不动也删不掉——要取消就在容器/systemd 里删掉那行再重启。");
  notes.push("换群或加群：粘贴新地址点「添加这条连接」，不需要的连接直接删除；每条都能单独点「测试」验证送达。");
  $("#hookHint").textContent = notes.join(" ");
}

function renderConfig(cfg, push) {
  const w = cfg.wecom;
  renderHooks(w, push);
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
  const b = state.build || {};
  $("#buildTag").textContent = b.version ? `版本 ${b.version}${b.time ? " · " + String(b.time).slice(0, 16) : ""}` : "版本未标记";
  renderStats(state);
  renderPending(state.reports);
  renderConfig(state.config, state.push);
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
  /* 机器人地址不在这里提交：它有自己的「保存/清空」按钮，避免点「保存全部设置」时误覆盖 */
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

/* 机器人地址：合法性由服务端判定（规则只有一份，前端不重复实现一遍防止走味） */
async function addTarget() {
  const hook = $("#webhook").value.trim();
  if (!hook) return toast("先把机器人地址粘贴进来");
  const r = await api("/api/admin/target-add", { method: "POST", body: JSON.stringify({ webhook: hook, name: $("#hookName").value.trim() }) });
  if (r.error) return toast(r.error);
  $("#webhook").value = "";
  $("#hookName").value = "";
  toast("已添加，点这条的「测试」确认能送达");
  await refresh();
}

async function toggleTarget(t) {
  const r = await api("/api/admin/target-update", { method: "POST", body: JSON.stringify({ id: t.id, enabled: !t.enabled }) });
  if (r.error) return toast(r.error);
  toast(`「${t.name}」已${t.enabled ? "停用" : "启用"}`);
  await refresh();
}

async function renameTarget(t) {
  const v = prompt("给这条连接起个名字（最多 24 字）", t.name);
  if (!v || !v.trim() || v.trim() === t.name) return;
  const r = await api("/api/admin/target-update", { method: "POST", body: JSON.stringify({ id: t.id, name: v.trim() }) });
  if (r.error) return toast(r.error);
  toast("名字已更新");
  await refresh();
}

async function removeTarget(t) {
  if (!confirm(`删除「${t.name}」${t.webhookHint}？以后这个群不会再收到推送。`)) return;
  const r = await api("/api/admin/target-remove", { method: "POST", body: JSON.stringify({ id: t.id }) });
  if (r.error) return toast(r.error);
  toast("已删除这条连接");
  await refresh();
}

async function testTarget(t) {
  toast(`正在给「${t.name}」发测试…`);
  const r = await api("/api/admin/target-test", { method: "POST", body: JSON.stringify({ id: t.id }) });
  if (r.error) return toast(r.error);
  toast(r.errcode === 0 ? `「${t.name}」已送达` : `「${t.name}」失败：${r.errmsg}${r.hint ? "｜" + r.hint : ""}`);
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
  $("#saveHookBtn").addEventListener("click", addTarget);
  $("#webhook").addEventListener("keydown", (e) => e.key === "Enter" && addTarget());
  $("#hookName").addEventListener("keydown", (e) => e.key === "Enter" && $("#webhook").focus());
}

/* 先看有没有有效会话（cookie 由浏览器管），有就直接进，没有就摆登录框 */
fetch("/api/admin/session", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((s) => (s.authed ? refresh().catch(() => {}) : showGate()))
  .catch(() => showGate());
bind();
