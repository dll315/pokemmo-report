#!/usr/bin/env node
"use strict";
/* 把静态快照推到 pages 分支（Pages 的分支托管模式）。
   用途：上游 Cloudflare 会拦 GitHub Actions 的数据中心 IP，纯 Actions 抓不到数据；
   于是改成"能连上上游的机器（自己的服务器/本机）定时抓 + 推 pages 分支"，
   Pages 只负责托管静态文件。在服务器上配一条 cron 即可。
     node tools/publish-pages.js [--branch=pages] [--skip-build] [--dry-run] */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const arg = (name, dft) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dft;
};
const BRANCH = arg("branch", "pages");
const DIST = path.join(ROOT, "dist");
const DRY = process.argv.includes("--dry-run");

function git(args, opts = {}) {
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return String(out ?? "").trim();
}

function build() {
  const { main } = require("./build-static");
  main("data");
}

/* 用独立索引文件打包 dist 内容，分支根就是 dist/ 里的东西，且不碰工作区的索引 */
function commitDist(ts) {
  const index = path.join(os.tmpdir(), `pages-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  fs.rmSync(index, { force: true });
  git(["read-tree", "--empty"], { env });
  execFileSync("git", ["add", "-f", "--", "."], { cwd: DIST, env, stdio: "pipe" });
  const tree = git(["write-tree"], { env });
  let parent = "";
  try {
    parent = git(["rev-parse", `origin/${BRANCH}`]);
  } catch (e) {
    parent = "";
  }
  const cmd = ["commit-tree", tree, "-m", `chore(pages): 更新静态快照 ${ts}`];
  if (parent) cmd.push("-p", parent);
  const commit = git(cmd);
  fs.rmSync(index, { force: true });
  return { commit, tree, parent: parent || "(首次)" };
}

function main() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) throw new Error("这里不是 git 仓库，publish-pages 只在有 .git 的地方用");
  if (!process.argv.includes("--skip-build")) build();
  const files = fs.readdirSync(DIST);
  if (!files.includes("index.html") || !files.includes("data.json")) throw new Error("dist 不完整，先跑 tools/build-static.js");
  const ts = new Date().toISOString();
  const info = commitDist(ts);
  console.log(`dist 内容：${files.join(", ")}`);
  console.log(`分支 ${BRANCH} | tree=${info.tree.slice(0, 8)} commit=${info.commit.slice(0, 8)} 父=${String(info.parent).slice(0, 8)}`);
  if (DRY) {
    console.log("--dry-run：不推送");
    return;
  }
  git(["push", "-f", "origin", `${info.commit}:refs/heads/${BRANCH}`]);
  console.log(`已推送 origin/${BRANCH}。Pages 需要设成"Deploy from a branch"→ 分支 ${BRANCH} /根目录`);
}

if (require.main === module) main();
