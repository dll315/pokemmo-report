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
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function readConfig() {
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    disk = {};
  }
  const cfg = deepMerge(DEFAULTS, disk);
  if (process.env.WECOM_WEBHOOK) cfg.wecom.webhook = process.env.WECOM_WEBHOOK;
  if (process.env.ADMIN_USER) cfg.adminUser = process.env.ADMIN_USER;
  if (process.env.ADMIN_PASSWORD) cfg.adminPassword = process.env.ADMIN_PASSWORD;
  return cfg;
}

/* 弱口令表只用来提醒，不拦着人用（站主自己选的密码，我们让他知道风险） */
const WEAK = new Set(["", "123456", "123456789", "admin", "admin123", "888888", "666666", "password", "qwerty", "abc123"]);
const isWeakPassword = (p) => WEAK.has(String(p || "").toLowerCase());

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

function masked(cfg) {
  const w = String(cfg.wecom.webhook || "");
  const p = webhookParts(w);
  return {
    ...cfg,
    wecom: {
      ...cfg.wecom,
      /* 完整 key 一旦回到前端就会进浏览器内存与响应日志，这里只回"够认出来是哪条"的部分 */
      webhook: "",
      webhookSet: !!w,
      webhookHint: w ? `${p.host}${p.path}…${p.key.slice(-6)}` : "",
      webhookOffHost: !!w && p.offHost,
      webhookSource: process.env.WECOM_WEBHOOK ? "env" : w ? "file" : "none",
    },
    adminPassword: cfg.adminPassword ? "••••••" : "",
    adminPasswordSet: !!cfg.adminPassword,
    adminPasswordWeak: isWeakPassword(cfg.adminPassword),
  };
}

module.exports = { FILE, DEFAULTS, readConfig, writeConfig, masked, isWeakPassword, webhookProblem, webhookParts };
