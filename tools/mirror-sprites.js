#!/usr/bin/env node
"use strict";
/* 把第五世代（黑白）图鉴图落到 public/assets/sprites/，前端不热链 GitHub——
   raw.githubusercontent.com 在境内基本打不开，热链等于让玩家看一堆裂图。

   取字节走公共 GitHub 代理，但**不需要信任它**：
   - 文件清单（名字 + git blob SHA-1 + 字节数）只认 api.github.com 的 git trees 接口；
     清单里没有的文件根本不去请求。
   - 每个文件落盘前重算 sha1("blob " + 长度 + "\0" + 内容)，与清单的 blob SHA 不一致就换通道，
     全不一致则记进 data/sprite-manifest.json 的 failed 并让退出码非 0。
   为什么用 git trees 而不是 contents：contents 一个目录最多返回 1000 条，而这个目录有 1343 张编号图
   （含超级进化/阿罗拉形态的 10000+ 编号）。实测 contents 列不出 999.png 但它真实存在，
   拿截断清单当依据会把合法文件误判成伪造。

     node tools/mirror-sprites.js [--only-universe] [--with-animated] [--ids=1,2,3] [--force] [--insecure]
   已存在的文件默认跳过，可反复运行；缺图不影响网站，前端退回首字徽章。 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "assets", "sprites");
const MANIFEST = path.join(ROOT, "data", "sprite-manifest.json");
const API = "https://api.github.com/repos/PokeAPI/sprites";
const GEN5 = "sprites/pokemon/versions/generation-v/black-white";
const RAW = `https://raw.githubusercontent.com/PokeAPI/sprites/master/${GEN5}`;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(a.indexOf("=") + 1) : "";
};

/* 传输通道：代理只负责搬字节，真伪由 blob SHA 把关。 */
const TRANSPORTS = []
  .concat(argVal("base") ? [argVal("base").replace(/\/+$/, "")] : [])
  .concat(process.env.SPRITE_BASE ? [process.env.SPRITE_BASE.replace(/\/+$/, "")] : [])
  .concat([`https://gh-proxy.com/${RAW}`, `https://ghproxy.net/${RAW}`, RAW]);

const CONCURRENCY = Number(argVal("concurrency") || 4);
const TIMEOUT = 20000;
const UA = "pokemmo-report-sprite-mirror/1.0 (zero-dependency build tool)";

function getBuffer(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA, Accept: "*/*" }, timeout: TIMEOUT }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 5) {
        res.resume();
        return resolve(getBuffer(new URL(loc, url).href, depth + 1));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`超时 ${url}`)));
    req.on("error", reject);
  });
}

async function getJson(url) {
  const { status, buf } = await getBuffer(url);
  if (status !== 200) throw new Error(`${url} → HTTP ${status}：${buf.toString("utf8").slice(0, 160)}`);
  return JSON.parse(buf.toString("utf8"));
}

const blobSha = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

function magicOk(name, buf) {
  if (name.endsWith(".png")) return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (name.endsWith(".gif")) return buf.length > 6 && buf.slice(0, 3).toString("latin1") === "GIF";
  return false;
}

/* 权威清单：sub("" 静态图 / "/animated" 动图) → Map(文件名 → {sha, size})。 */
async function authoritativeIndex(needAnimated) {
  const parent = GEN5.slice(0, GEN5.lastIndexOf("/"));
  const leaf = GEN5.slice(GEN5.lastIndexOf("/") + 1);
  const rows = [].concat(await getJson(`${API}/contents/${parent}`));
  const dir = rows.find((e) => (e.type === "dir" || e.type === "tree") && e.name === leaf);
  if (!dir) throw new Error(`${parent} 下找不到 ${leaf}`);
  const index = { "": new Map(), "/animated": new Map() };
  const top = await getJson(`${API}/git/trees/${dir.sha}`);
  if (top.truncated) throw new Error("git trees 返回被截断，清单不完整，不敢继续");
  for (const e of top.tree) if (e.type === "blob" && /^\d+\.png$/.test(e.path)) index[""].set(e.path, { sha: e.sha, size: e.size });
  if (needAnimated) {
    const anim = top.tree.find((e) => e.type === "tree" && e.path === "animated");
    if (!anim) throw new Error("清单里没有 animated 子目录");
    const sub = await getJson(`${API}/git/trees/${anim.sha}`);
    if (sub.truncated) throw new Error("animated 子树被截断");
    for (const e of sub.tree) if (e.type === "blob" && /^\d+\.gif$/.test(e.path)) index["/animated"].set(e.path, { sha: e.sha, size: e.size });
  }
  return index;
}

function targetIds() {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, "data/upstream/pokesearch-data.json"), "utf8"));
  if (!has("--only-universe")) return list.map((p) => Number(p.id)).filter(Boolean);
  const byName = new Map(list.map((p) => [String(p.name).toLowerCase(), Number(p.id)]));
  const uni = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "data/species-universe.json"), "utf8")).map((n) => String(n).toLowerCase()));
  return list.filter((p) => uni.has(String(p.name).toLowerCase())).map((p) => Number(p.id)).filter(Boolean);
}

async function main() {
  const only = argVal("ids");
  const ids = only ? [...new Set(only.split(/[,，\s]+/).map(Number).filter(Boolean))] : [...new Set(targetIds())].sort((a, b) => a - b);
  const kinds = [["", ".png"]].concat(has("--with-animated") ? [["/animated", ".gif"]] : []);
  const wantAnimated = has("--with-animated");

  fs.mkdirSync(OUT, { recursive: true });
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : {};
  manifest.files = manifest.files || {};
  manifest.failed = manifest.failed || {};

  let index = null;
  try {
    index = await authoritativeIndex(wantAnimated);
    console.log(`权威清单（api.github.com git trees）：静态 ${index[""].size} 项${wantAnimated ? ` / 动图 ${index["/animated"].size} 项` : ""}`);
  } catch (e) {
    if (!has("--insecure")) {
      console.error(`拿不到权威清单（${e.message}）。恢复网络重试，或明确加 --insecure 降级为只验魔数。`);
      process.exit(2);
    }
    console.log("⚠ --insecure：没有清单，只按文件魔数放行（取证记为 magicOnly）");
  }

  const jobs = [];
  const absent = [];
  for (const id of ids) for (const [sub, ext] of kinds) {
    const name = `${id}${ext}`;
    if (index && !index[sub].has(name)) { absent.push(name); continue; }   // 上游本就没有这张图，不发请求
    const rec = manifest.files[name];
    if (!has("--force") && fs.existsSync(path.join(OUT, name)) && rec && (rec.verified || rec.magicOnly)) continue;
    jobs.push({ id, sub, ext, name, dest: path.join(OUT, name) });
  }
  const total = jobs.length;
  console.log(`待取 ${total} 个文件（并发 ${CONCURRENCY}，通道 ${TRANSPORTS.length} 条），上游无此图 ${absent.length} 个`);

  const t0 = Date.now();
  let done = 0, ok = 0, bad = 0, bytes = 0;
  const tally = {};

  async function worker() {
    for (;;) {
      const job = jobs.shift();
      if (!job) return;
      const expected = index ? index[job.sub].get(job.name) : null;
      let lastErr = "所有通道都没拿到";
      let got = null;
      for (let i = 0; i < TRANSPORTS.length && !got; i++) {
        const base = TRANSPORTS[(job.id + i) % TRANSPORTS.length];
        const host = new URL(base).host;
        let r;
        try {
          r = await getBuffer(`${base}${job.sub}/${job.name}`);
        } catch (e) {
          lastErr = `${host}: ${e.message}`;
          continue;
        }
        if (r.status !== 200 || !r.buf.length) { lastErr = `${host}: HTTP ${r.status}`; continue; }
        if (!magicOk(job.name, r.buf)) { lastErr = `${host}: 返回的不是图片（魔数不对）`; continue; }
        if (expected && blobSha(r.buf) !== expected.sha) { lastErr = `${host}: blob SHA 与清单不符（期望 ${expected.sha.slice(0, 10)}）`; continue; }
        if (expected && r.buf.length !== expected.size) { lastErr = `${host}: 字节数与清单不符`; continue; }
        fs.writeFileSync(job.dest, r.buf);
        manifest.files[job.name] = {
          sha: expected ? expected.sha : null, bytes: r.buf.length, via: host,
          verified: !!expected, magicOnly: !expected, at: new Date().toISOString(),
        };
        delete manifest.failed[job.name];
        tally[host] = (tally[host] || 0) + 1;
        bytes += r.buf.length;
        got = true;
        ok++;
      }
      if (!got) {
        bad++;
        manifest.failed[job.name] = { reason: lastErr, at: new Date().toISOString() };
        delete manifest.files[job.name];
      }
      done++;
      if (done % 40 === 0) process.stdout.write(`\r  ${done}/${total}  成功 ${ok}  失败 ${bad}   `);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  /* 清单必须与磁盘一致：手工删过图或换过 --ids 范围时，把已经不存在的登记项裁掉 */
  let pruned = 0;
  for (const name of Object.keys(manifest.files)) {
    if (!/^\d+\.(png|gif)$/.test(name) || !fs.existsSync(path.join(OUT, name))) { delete manifest.files[name]; pruned++; }
  }
  for (const name of Object.keys(manifest.failed)) if (fs.existsSync(path.join(OUT, name))) delete manifest.failed[name];
  manifest.generatedAt = new Date().toISOString();
  manifest.source = `PokeAPI/sprites @ ${GEN5}`;
  manifest.verifiedBy = "git blob sha1，清单取自 api.github.com git trees";
  manifest.absentFromUpstream = absent;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

  const verified = Object.values(manifest.files).filter((f) => f.verified).length;
  const magicOnly = Object.values(manifest.files).filter((f) => f.magicOnly).length;
  process.stdout.write(" ".repeat(40) + "\r");
  console.log(`完成 ${ok}/${total}（${(bytes / 1048576).toFixed(2)} MB），失败 ${bad}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s，通道 ${JSON.stringify(tally)}`);
  console.log(`图片 → ${path.relative(ROOT, OUT)}；取证 → ${path.relative(ROOT, MANIFEST)}（blob SHA 校验 ${verified} 个 / 仅魔数 ${magicOnly} 个）`);
  if (bad) {
    const f = Object.entries(manifest.failed);
    console.log(`失败 ${f.length} 个，样例：${f.slice(0, 5).map(([k, v]) => `${k}(${v.reason})`).join("  ")}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
