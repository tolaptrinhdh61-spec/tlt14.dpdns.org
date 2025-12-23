#!/usr/bin/env node
/**
 * run-nginx.mjs
 * - Ensure repo-local nginx runtime directories exist
 * - nginx -t (validate)
 * - start nginx foreground (daemon off)
 * - Auto reload if nginx is already running
 *
 * Env:
 * - APP_CWD: repo root (default: process.cwd())
 * - NGINX_CONF_PATH: absolute/relative path to nginx.conf (default: <APP_CWD>/nginx.conf)
 * - NGINX_PREFIX: nginx prefix folder for logs/run/temp (default: <APP_CWD>/nginx)
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const CWD = process.env.APP_CWD ? path.resolve(process.env.APP_CWD) : process.cwd();
const NGINX_CONF_PATH = process.env.NGINX_CONF_PATH ? path.resolve(CWD, process.env.NGINX_CONF_PATH) : path.join(CWD, "nginx.conf");
const NGINX_PREFIX = process.env.NGINX_PREFIX ? path.resolve(CWD, process.env.NGINX_PREFIX) : path.join(CWD, "nginx");
const PID_FILE = path.join(NGINX_PREFIX, "run", "nginx.pid");

// lấy conf: ưu tiên base64
const confB64 = process.env.NGINX_CONF__BASE64__ || "";
const confRaw = process.env.NGINX_CONF || "";

const conf = confB64 ? Buffer.from(confB64, "base64").toString("utf8") : confRaw;

if (!conf || !conf.trim()) {
  console.error("❌ Missing nginx config. Provide NGINX_CONF__BASE64__ or NGINX_CONF.");
  process.exit(2);
}

// ✅ These match your nginx.conf:
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

/**
 * Kiểm tra xem nginx có đang chạy không (qua PID file)
 */
function isNginxRunning() {
  if (!fs.existsSync(PID_FILE)) return false;

  try {
    const pid = fs.readFileSync(PID_FILE, "utf8").trim();
    if (!pid) return false;

    // Kiểm tra process có tồn tại không (kill -0 không kill process, chỉ check)
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch (err) {
    // Process không tồn tại hoặc không có quyền
    return false;
  }
}

/**
 * Reload nginx bằng cách gửi signal HUP
 */
function reloadNginx() {
  try {
    const pid = fs.readFileSync(PID_FILE, "utf8").trim();
    console.log(`🔄 Nginx đang chạy (PID: ${pid}), reload config...`);

    // Validate config trước khi reload
    execSync(`nginx -t -p "${NGINX_PREFIX}" -c "${NGINX_CONF_PATH}"`, { stdio: "inherit" });

    // Gửi signal SIGHUP để reload
    process.kill(parseInt(pid, 10), "SIGHUP");
    console.log("✅ Nginx config đã được reload thành công!");
    return true;
  } catch (err) {
    console.error("❌ Lỗi khi reload nginx:", err.message);
    return false;
  }
}

function main() {
  console.log("=== run-nginx.mjs ===");
  console.log("CWD:", CWD);
  console.log("NGINX_CONF_PATH:", NGINX_CONF_PATH);
  console.log("NGINX_PREFIX:", NGINX_PREFIX);

  ensureDirs();

  // Ghi file nginx.conf mới
  const oldConf = fs.existsSync(NGINX_CONF_PATH) ? fs.readFileSync(NGINX_CONF_PATH, "utf8") : "";
  const configChanged = oldConf !== conf;

  fs.writeFileSync(NGINX_CONF_PATH, conf, { encoding: "utf8" });
  console.log("✅ Wrote nginx.conf at:", NGINX_CONF_PATH);

  mustExist(NGINX_CONF_PATH, "nginx.conf not found");

  console.log("✅ Ensured nginx runtime dirs:");
  for (const d of REQUIRED_DIRS) console.log(" -", d);

  // Kiểm tra nginx đã chạy chưa
  if (isNginxRunning()) {
    if (configChanged) {
      console.log("⚠️  Nginx.conf đã thay đổi");
      if (reloadNginx()) {
        console.log("🎉 Hoàn tất! Nginx đang chạy với config mới.");
        process.exit(0);
      } else {
        console.log("⚠️  Reload thất bại, tiếp tục khởi động lại...");
      }
    } else {
      console.log("✅ Nginx đang chạy và config không đổi, không cần reload.");
      process.exit(0);
    }
  }

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
