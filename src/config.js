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

function masked(cfg) {
  const key = (cfg.wecom.webhook || "").split("key=")[1] || "";
  return {
    ...cfg,
    wecom: { ...cfg.wecom, webhook: "", webhookSet: !!cfg.wecom.webhook, webhookHint: key ? `…${key.slice(-6)}` : "" },
    adminPassword: cfg.adminPassword ? "••••••" : "",
    adminPasswordSet: !!cfg.adminPassword,
    adminPasswordWeak: isWeakPassword(cfg.adminPassword),
  };
}

module.exports = { FILE, DEFAULTS, readConfig, writeConfig, masked, isWeakPassword };
