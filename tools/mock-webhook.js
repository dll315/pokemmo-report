#!/usr/bin/env node
"use strict";
/* 本地假的企业微信机器人端点：把收到的消息原样打印出来，用来验证推送排版，
   不会真的往群里发东西。 node tools/mock-webhook.js [端口]  默认 3599 */

const http = require("http");
const PORT = Number(process.argv[2]) || 3599;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const t = new Date().toISOString().slice(11, 19);
      console.log(`\n[${t}] ${req.method} ${req.url}`);
      try {
        const j = JSON.parse(body);
        console.log("msgtype:", j.msgtype);
        console.log(j.markdown ? j.markdown.content : JSON.stringify(j));
      } catch (e) {
        console.log("raw:", body);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock webhook  http://127.0.0.1:${PORT}/send?key=MOCK`));
