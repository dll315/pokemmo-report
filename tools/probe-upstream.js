#!/usr/bin/env node
"use strict";
/* 上游连通性探针：只用来看"能不能抓到数据"这件事本身，打印状态码与 Cloudflare 侧线索。
   Actions 里作为独立一步跑，同步失败时不用猜是代码坏了还是被 WAF 拦了。
     node tools/probe-upstream.js */

const up = require("../src/upstream");
const { request, makeJar } = require("../src/net");

(async () => {
  const jar = makeJar();
  const targets = [["页面 /history", up.BASE + "/history"], ["接口 /api/alpha-spawn-data", up.BASE + "/api/alpha-spawn-data"]];
  let okCount = 0;
  for (const [label, url] of targets) {
    try {
      const r = await request(url, { jar, retries: 1, headers: { Accept: "text/html,application/json" } });
      const cf = r.headers["cf-cache-status"] || "-";
      const ray = r.headers["cf-ray"] || "-";
      const snippet = (r.text || "").replace(/\s+/g, " ").slice(0, 90);
      console.log(`${label}: HTTP ${r.status} | server=${r.headers.server || "-"} cf-cache=${cf} cf-ray=${ray}`);
      console.log(`   body: ${snippet}`);
      if (r.status === 200) okCount++;
    } catch (e) {
      console.log(`${label}: 请求失败 ${e.message}`);
    }
  }
  console.log(okCount === targets.length ? "探针结论：上游可达，可继续同步" : "探针结论：上游拒绝本机 IP/UA（多为 Cloudflare 拦数据中心），同步会拿不到数据");
  process.exit(okCount === targets.length ? 0 : 1);
})();
