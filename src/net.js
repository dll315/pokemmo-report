"use strict";
/* 零依赖 HTTP 客户端：node:https 封装，带超时、重试和最小 cookie jar。
   不用 fetch 是为了兼容国内服务器上常见的旧版 Node（16/18）。 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 单次请求，不重试。返回 {status, headers, text, json} */
function raw(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        method: opts.method || "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        headers: opts.headers || {},
        timeout: opts.timeoutMs || 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch (e) {
              json = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`请求超时: ${u.pathname}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* 带重试的请求。429/5xx/网络错误退避重试；4xx 直接返回给调用方判断。 */
async function request(urlStr, opts = {}) {
  const attempts = opts.retries ?? 3;
  const headers = { "User-Agent": UA, Accept: "application/json, text/html;q=0.9", ...(opts.headers || {}) };
  if (opts.jar && opts.jar.header()) headers.Cookie = opts.jar.header();

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await raw(urlStr, { ...opts, headers });
      if (opts.jar) opts.jar.absorb(res.headers["set-cookie"]);
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await sleep(1200 * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1200 * 2 ** i);
    }
  }
  throw lastErr || new Error("请求失败");
}

/* 只保留本次会话拿到的 cookie，够用且不落盘 */
function makeJar() {
  const map = new Map();
  return {
    absorb(setCookie) {
      if (!setCookie) return;
      for (const line of [].concat(setCookie)) {
        const kv = line.split(";")[0];
        const eq = kv.indexOf("=");
        if (eq > 0) map.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
      }
    },
    header() {
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get size() {
      return map.size;
    },
  };
}

module.exports = { request, makeJar, sleep, UA };
