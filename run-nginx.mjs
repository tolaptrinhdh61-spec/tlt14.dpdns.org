#!/usr/bin/env node
/**
 * run-nginx.mjs
 * - Ensure repo-local nginx runtime directories exist
 * - nginx -t (validate)
 * - start nginx foreground (daemon off)
 *
 * Env:
 * - APP_CWD: repo root (default: process.cwd())
 * - NGINX_CONF_PATH: absolute/relative path to nginx.conf (default: <APP_CWD>/nginx.conf)
 * - NGINX_PREFIX: nginx prefix folder for logs/run/temp (default: <APP_CWD>/nginx)
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CWD = process.env.APP_CWD ? path.resolve(process.env.APP_CWD) : process.cwd();
const NGINX_CONF_PATH = process.env.NGINX_CONF_PATH ? path.resolve(CWD, process.env.NGINX_CONF_PATH) : path.join(CWD, "nginx.conf");
const NGINX_PREFIX = process.env.NGINX_PREFIX ? path.resolve(CWD, process.env.NGINX_PREFIX) : path.join(CWD, "nginx");

// lấy conf: ưu tiên base64
const confB64 = process.env.NGINX_CONF__BASE64__ || "";
const confRaw = process.env.NGINX_CONF || "";

const conf = confB64 ? Buffer.from(confB64, "base64").toString("utf8") : confRaw;

if (!conf || !conf.trim()) {
  console.error("❌ Missing nginx config. Provide NGINX_CONF__BASE64__ or NGINX_CONF.");
  process.exit(2);
}

// ghi file nginx.conf
fs.writeFileSync(NGINX_CONF_PATH, conf, { encoding: "utf8" });
console.log("✅ Wrote nginx.conf at:", NGINX_CONF_PATH);

// ✅ These match your nginx.conf:
//   error_log logs/...; pid run/...;
//   client_body_temp_path temp/client_body ...;
//   proxy_temp_path temp/proxy ...;
//   fastcgi_temp_path temp/fastcgi ...;
//   uwsgi_temp_path temp/uwsgi ...;
//   scgi_temp_path temp/scgi ...;
const REQUIRED_DIRS = [
  path.join(NGINX_PREFIX, "logs"),
  path.join(NGINX_PREFIX, "run"),
  path.join(NGINX_PREFIX, "temp", "client_body"),
  path.join(NGINX_PREFIX, "temp", "proxy"),
  path.join(NGINX_PREFIX, "temp", "fastcgi"),
  path.join(NGINX_PREFIX, "temp", "uwsgi"),
  path.join(NGINX_PREFIX, "temp", "scgi"),
];

function ensureDirs() {
  for (const d of REQUIRED_DIRS) fs.mkdirSync(d, { recursive: true });
}

function runNginx(args, label) {
  const p = spawn("nginx", args, {
    cwd: CWD,
    env: process.env,
    stdio: "inherit",
  });

  p.on("exit", (code, signal) => {
    if (signal) {
      console.error(`❌ ${label} exited via signal: ${signal}`);
      process.exit(1);
    }
    if (code !== 0) {
      console.error(`❌ ${label} exited with code: ${code}`);
      process.exit(code ?? 1);
    }
  });

  return p;
}

function mustExist(filePath, msg) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ ${msg}: ${filePath}`);
    process.exit(2);
  }
}

function main() {
  console.log("=== run-nginx.mjs ===");
  console.log("CWD:", CWD);
  console.log("NGINX_CONF_PATH:", NGINX_CONF_PATH);
  console.log("NGINX_PREFIX:", NGINX_PREFIX);

  mustExist(NGINX_CONF_PATH, "nginx.conf not found");
  ensureDirs();

  console.log("✅ Ensured nginx runtime dirs:");
  for (const d of REQUIRED_DIRS) console.log(" -", d);

  console.log("🔍 nginx -t ...");
  runNginx(["-t", "-p", NGINX_PREFIX, "-c", NGINX_CONF_PATH], "nginx -t");

  console.log("🚀 Starting nginx (daemon off) ...");
  const nginx = runNginx(["-p", NGINX_PREFIX, "-c", NGINX_CONF_PATH, "-g", "daemon off;"], "nginx");

  const shutdown = (sig) => {
    console.log(`🛑 Received ${sig}, stopping nginx...`);
    try {
      nginx.kill("SIGTERM");
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
