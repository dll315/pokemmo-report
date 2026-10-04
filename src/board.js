"use strict";
/* 看板数据组装，server 与静态构建（GitHub Pages 路径）共用，避免两套口径。 */

const { slots } = require("./slots");
const { fmtBeijing } = require("./rules");
const refdata = require("./refdata");

function boardData(store, query = {}) {
  const now = Math.floor(Date.now() / 1000);
  const pick = (kind, limit) => {
    const r = store.events({ kind, activeOnly: true, limit, region: query.region || "", q: query.q || "" });
    return r.rows.map((e) => ({
      ...e,
      remaining: Math.max(0, (e.expiresUnix || e.tsUnix) - now),
      reportedBeijing: fmtBeijing(e.tsUnix),
      expireBeijing: fmtBeijing(e.expiresUnix || e.tsUnix),
      req: refdata.requirementFor(e),
    }));
  };
  const alpha = pick("alpha", 40);
  const swarm = pick("swarm", 40);
  const pheno = pick("pheno", 20);
  const all = store.events({ limit: 0 });
  const opts = refdata.options();
  return {
    now,
    beijingNow: fmtBeijing(now),
    generatedAt: new Date().toISOString(),
    mode: query.mode || "live",
    slots: slots(now),
    alpha,
    swarm,
    pheno,
    stats: {
      active: alpha.length + swarm.length + pheno.length,
      stored: all.total,
      bySource: { upstream: store.events({ source: "upstream", limit: 0 }).total, local: store.events({ source: "local", limit: 0 }).total },
      pendingReports: (store.db.reports || []).filter((r) => r.status === "pending").length,
    },
    queue: (store.db.queue || []).length,
    lastSyncAt: store.db.meta.lastSyncAt,
    lastSyncError: store.db.meta.lastSyncError,
    upstream: { staticLoaded: opts.upstreamLoaded, species: opts.species.length, locations: refdata.locationCount() },
  };
}

module.exports = { boardData };
