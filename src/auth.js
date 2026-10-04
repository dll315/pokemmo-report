"use strict";
/* 管理台登录态：账号密码校验通过后发一个 HttpOnly cookie，会话只存内存。
   容器重启就全部退出（可接受），不把凭据落盘；同时给登录接口做限频，
   挡一下拿字典撞弱口令的情况。 */

const crypto = require("crypto");

const TTL_MS = 12 * 60 * 60 * 1000;
const ATTEMPTS = { max: 8, windowMs: 10 * 60 * 1000 };
const sessions = new Map();
const attempts = new Map();

const newToken = () => crypto.randomBytes(24).toString("hex");

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function login(user, password, cfg) {
  if (!cfg.adminPassword) return { ok: false, error: "未设置管理密码" };
  const uOk = safeEqual(String(user || ""), String(cfg.adminUser || "admin"));
  const pOk = safeEqual(String(password || ""), String(cfg.adminPassword));
  if (!uOk || !pOk) return { ok: false, error: "账号或密码不对" };
  const token = newToken();
  sessions.set(token, { user: String(cfg.adminUser || "admin"), exp: Date.now() + TTL_MS });
  return { ok: true, token, user: sessions.get(token).user };
}

function whoami(header) {
  const token = parseCookies(header).admin_session;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...s, token };
}

function logout(header) {
  const token = parseCookies(header).admin_session;
  if (token) sessions.delete(token);
}

function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < ATTEMPTS.windowMs);
  return list.length >= ATTEMPTS.max;
}

function recordAttempt(ip) {
  const now = Date.now();
  attempts.set(ip, [...(attempts.get(ip) || []).filter((t) => now - t < ATTEMPTS.windowMs), now]);
}

/* 会话与失败计数都得定期清，否则长期运行会一直涨 */
function sweep() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t);
  for (const [ip, list] of attempts) {
    const alive = list.filter((x) => now - x < ATTEMPTS.windowMs);
    if (alive.length) attempts.set(ip, alive);
    else attempts.delete(ip);
  }
}

module.exports = { login, logout, whoami, cookieHeader, tooMany, recordAttempt, sweep, TTL_MS, sessions, CookieName: "admin_session" };
