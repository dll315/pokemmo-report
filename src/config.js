"use strict";
/* 运行配置：data/config.json（已 gitignore）+ 环境变量覆盖。
   放 data/ 是因为容器部署挂载的就是这个目录；写在镜像里的话 docker run 重建会把网页上配好的 webhook 丢掉。
   环境变量优先，且优先级高的来源在网页上改动不会生效，启动时会打印提醒。 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  adminUser: "admin",
  adminPassword: "123456",
  publicReport: true,
  reportRequireApprove: true,
  wecom: {
    webhook: "",
    enabled: true,
    kinds: ["alpha", "swarm"],
    onlyPokemon: [],
    exceptPokemon: [],
    regions: [],
    minTier: 0,
    maxPerTick: 4,
    quietHours: { enabled: false, from: "01:00", to: "07:00" },
  },
  sync: { intervalMinutes: 2, backfillHours: 48, retentionDays: 7 },
  /* 报点有效期：Alpha 75 分钟、Swarm 最多 25 分钟（上游前端常量 SWARM_DURATION_MINUTES_MAX / 75*60*1000） */
  windows: { alphaMinutes: 75, swarmMinutes: 25 },
};

const ROOT = path.resolve(__dirname, "..");
const FILE = process.env.CONFIG_FILE || path.join(ROOT, "data", "config.json");

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    /* 数组一律整体替换：连接列表要能删到只剩一条甚至清空，逐元素合并会把多余的旧项留在后面 */
    if (Array.isArray(v)) out[k] = [...v];
    else if (v && typeof v === "object" && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/* 连接列表：磁盘里没写过 targets 时，把旧的单条 webhook 认作"默认群"这一条。
   环境变量 WECOM_WEBHOOK 是"多出来的一条且网页改不动"，不是覆盖全部。 */
function normalizeTargets(wecom) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const url = String(t.webhook || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ id: String(t.id || "").slice(0, 16) || `t${out.length + 1}`, name: String(t.name || "").slice(0, 24) || `连接 ${out.length + 1}`, webhook: url, enabled: t.enabled !== false, addedAt: Number(t.addedAt) || 0, locked: !!t.locked });
  };
  if (Array.isArray(wecom.targets)) wecom.targets.forEach((t, i) => add({ id: `t${i + 1}`, ...t }));
  else if (wecom.webhook) add({ id: "legacy", name: "默认群", webhook: wecom.webhook });
  const envUrl = String(process.env.WECOM_WEBHOOK || "").trim();
  if (envUrl) {
    add({ id: "env", name: "环境变量注入", webhook: envUrl, enabled: true, locked: true });
    /* 同一条地址磁盘上可能已经有了（add 里按地址去重），那就只标锁定；env 那条排最前面，
       这样派生出来的 cfg.wecom.webhook 仍是环境变量的，跟老行为一致 */
    const i = out.findIndex((t) => t.webhook === envUrl);
    out[i].locked = true;
    if (i > 0) out.unshift(out.splice(i, 1)[0]);
  }
  return out;
}

const targetId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function readConfig() {
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    disk = {};
  }
  const cfg = deepMerge(DEFAULTS, disk);
  if (process.env.ADMIN_USER) cfg.adminUser = process.env.ADMIN_USER;
  if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;
  cfg.wecom.targets = normalizeTargets(cfg.wecom);
  /* 老代码（限流判断、跑批脚本）读的是 cfg.wecom.webhook，这里让它始终等于第一条启用的连接 */
  cfg.wecom.webhook = (cfg.wecom.targets.find((t) => t.enabled) || {}).webhook || "";
  return cfg;
}

/* 弱口令表只用来提醒，不拦着人用（站主自己选的密码，我们让他知道风险） */
const WEAK = new Set(["", "123456", "123456789", "admin", "admin123", "888888", "666666", "password", "qwerty", "abc123"]);
const isWeakPassword = (p) => WEAK.has(String(p || "").toLowerCase());

/* 文档里的占位符被原样照抄成密码是真实发生过的（"换成你自己的密码" 8 个汉字），
   这类值一律在启动时喊一声，免得人对着"密码错误"查半天。 */
const PLACEHOLDER_HINTS = ["换成你", "你自己", "你的密码", "你的账号", "自己定", "修改这", "placeholder", "changeme", "your-", "xxxx"];
function placeholderPassword(p) {
  const s = String(p || "");
  if (!s) return "";
  const low = s.toLowerCase();
  const hit = PLACEHOLDER_HINTS.find((k) => low.includes(k));
  if (hit) return `看起来是文档里的占位符（含"${hit}"）`;
  if (/[^\x00-\x7f]/.test(s)) return "含中文或全角字符，多半是复制提示语时带进去的";
  return "";
}

function writeConfig(patch) {
  const disk = (() => {
    try {
      return JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch (e) {
      return {};
    }
  })();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(deepMerge(disk, patch), null, 2) + "\n", "utf8");
  return readConfig();
}

/* 机器人地址的校验：只看形状，不联网。允许 http:// 是为了本机 mock 端点能验通链路，
   但域名不是企业微信官方时会单独标出来，界面上给一句提醒。 */
function webhookProblem(url) {
  const s = String(url || "").trim();
  if (!s) return "地址是空的";
  if (/[\s\u3000]/.test(s)) return "里面有空格或换行，请把整条地址原样重新粘贴";
  let u;
  try { u = new URL(s); } catch (e) { return "不是合法 URL，要 https:// 开头的完整一条"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "只支持 http(s):// 地址";
  if (!/[?&]key=[^&]+/.test(u.search)) return "没看到 key= 参数，确认是从群机器人设置里复制的完整地址";
  return null;
}

function webhookParts(url) {
  const out = { host: "", path: "", key: "", offHost: false };
  try {
    const u = new URL(String(url || "").trim());
    out.host = u.hostname;
    out.path = u.pathname;
    out.key = (u.search.match(/key=([^&]+)/) || [])[1] || "";
    out.offHost = u.hostname !== "qyapi.weixin.qq.com";
  } catch (e) { /* 空或非法，留默认值 */ }
  return out;
}

/* 够认出是哪条、不够拼出整条地址：完整 key 一旦回前端就会进浏览器内存和响应日志 */
function webhookHint(url) {
  const p = webhookParts(url);
  return p.host ? `${p.host}${p.path}…${p.key.slice(-6)}` : "";
}

function masked(cfg) {
  const w = String(cfg.wecom.webhook || "");
  const targets = (cfg.wecom.targets || []).map((t) => ({
    id: t.id, name: t.name, enabled: t.enabled, locked: !!t.locked, addedAt: t.addedAt,
    webhook: "", webhookHint: webhookHint(t.webhook), offHost: webhookParts(t.webhook).offHost,
  }));
  const first = (cfg.wecom.targets || []).find((t) => t.enabled);
  return {
    ...cfg,
    wecom: {
      ...cfg.wecom,
      webhook: "",
      targets,
      webhookSet: !!w,
      webhookHint: webhookHint(w),
      webhookOffHost: !!w && webhookParts(w).offHost,
      webhookSource: first ? (first.locked ? "env" : "file") : "none",
    },
    adminPassword: cfg.adminPassword ? "••••••" : "",
    adminPasswordSet: !!cfg.adminPassword,
    adminPasswordWeak: isWeakPassword(cfg.adminPassword),
    adminPasswordPlaceholder: placeholderPassword(cfg.adminPassword),
    adminPasswordFromEnv: !!process.env.ADMIN_PASSWORD,
  };
}

module.exports = { FILE, DEFAULTS, readConfig, writeConfig, masked, isWeakPassword, placeholderPassword, webhookProblem, webhookParts, webhookHint, normalizeTargets, targetId };
