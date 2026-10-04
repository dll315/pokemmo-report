#!/usr/bin/env node
"use strict";
/* 把第五世代（黑白）图鉴图镜像到 public/assets/sprites/，避免前端热链 GitHub。
   国内机器通常直连不到 raw.githubusercontent.com，两种办法：
     1) 开代理并让 Node 用它：HTTPS_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node tools/mirror-sprites.js
     2) 换成你自己能访问的镜像根：node tools/mirror-sprites.js --base=https://你的镜像/.../black-white
   图缺失不影响网站使用，只是不显示小图标。已存在的文件跳过，可反复运行。
     node tools/mirror-sprites.js [--only-universe] [--base=…] [--force] */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public", "assets", "sprites");
const DEFAULT_BASE = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white";
const CONCURRENCY = 6;

const argv = process.argv.slice(2);
const BASES = [];
const baseArg = argv.find((a) => a.startsWith("--base="));
if (baseArg) BASES.push(baseArg.split("=").slice(1).join("="));
if (process.env.SPRITE_BASE) BASES.push(process.env.SPRITE_BASE);
BASES.push(DEFAULT_BASE, "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white");

function targets() {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, "data/upstream/pokesearch-data.json"), "utf8"));
  if (!argv.includes("--only-universe")) return list.map((p) => Number(p.id)).filter(Boolean);
  const universe = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "data/species-universe.json"), "utf8")).map((n) => String(n).toLowerCase()));
  return list.filter((p) => universe.has(String(p.name).toLowerCase())).map((p) => Number(p.id));
}

async function grabOne(id) {
  if (!argv.includes("--force")) {
    for (const ext of [".gif", ".png"]) if (fs.existsSync(path.join(OUT, `${id}${ext}`))) return { id, skipped: true };
  }
  for (const base of BASES) {
    for (const [sub, ext] of [["/animated", ".gif"], ["", ".png"]]) {
      try {
        const r = await fetch(`${base}${sub}/${id}${ext}`, { redirect: "follow", signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 42) {
          fs.writeFileSync(path.join(OUT, `${id}${ext}`), buf);
          return { id, ok: true, bytes: buf.length };
        }
      } catch (e) {
        /* 换下一个来源 */
      }
    }
  }
  return { id, ok: false };
}

async function main() {
  if (typeof fetch !== "function") {
    console.error("需要 Node 18+ 的内置 fetch（当前版本太旧）。可改用：npx node@20 tools/mirror-sprites.js");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const ids = targets();
  const failed = [];
  let written = 0;
  let exists = 0;
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const r = await grabOne(queue.shift());
      if (r.skipped) exists++;
      else if (r.ok) written++;
      else failed.push(r.id);
      process.stdout.write(`\r新写 ${written} · 已存在 ${exists} · 失败 ${failed.length} · 待抓 ${queue.length}    `);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("");
  if (failed.length) {
    console.log(`失败 ${failed.length} 个。GitHub 在你的网络里大概率不通，开代理重试：`);
    console.log("  HTTPS_PROXY=http://127.0.0.1:10809 NODE_USE_ENV_PROXY=1 node tools/mirror-sprites.js --only-universe");
  } else {
    const files = fs.readdirSync(OUT).filter((f) => /\.(gif|png)$/.test(f));
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
    console.log(`完成：图片 ${files.length} 张，约 ${(bytes / 1048576).toFixed(1)} MB`);
  }
}

if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
