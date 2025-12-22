#!/usr/bin/env node
/**
 * Deploy ntfy (docker compose) using repo config + workspace sqlite (outside repo)
 *
 * ✅ What it does:
 *   - Validate required repo files: ./docker-compose.yml, ./config/server.yml
 *   - Create data dir OUTSIDE repo (prefer PIPELINE_WORKSPACE / AGENT_TEMPDIRECTORY)
 *   - Create/ensure sqlite placeholders: cache.db, user.db
 *   - Create symlink in repo: ./.ntfy -> <outside-data>  (so docker compose mount ./ .ntfy still works)
 *   - docker compose pull + up -d
 *   - Wait health: http://127.0.0.1:${NTFY_PORT}/v1/health  (healthy=true)
 *   - Smoke test publish (admin) to /pipeline-test
 *   - Print files in outside data dir
 *
 * 🔧 Requirements:
 *   - Node.js 18+ (built-in fetch)
 *   - Docker + docker compose
 *
 * 🗓️ Last updated: 2025-12-21 (Asia/Ho_Chi_Minh)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const REPO = process.env.BUILD_SOURCESDIRECTORY || process.cwd();
process.chdir(REPO);

const NTFY_PORT = String(process.env.NTFY_PORT || "").trim();
const NTFY_ADMIN_USER = String(process.env.NTFY_ADMIN_USER || "").trim();
const NTFY_ADMIN_PASS = String(process.env.NTFY_ADMIN_PASS || "").trim();

if (!NTFY_PORT) die("❌ Missing env NTFY_PORT");
if (!NTFY_ADMIN_USER) die("❌ Missing env NTFY_ADMIN_USER");
if (!NTFY_ADMIN_PASS) die("❌ Missing env NTFY_ADMIN_PASS");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function existsOrDie(rel, msg) {
  const p = path.join(REPO, rel);
  if (!fs.existsSync(p)) die(msg);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.error) die(`❌ Failed: ${cmd} ${args.join(" ")}\n${r.error}`);
  if (typeof r.status === "number" && r.status !== 0) die(`❌ Exit ${r.status}: ${cmd} ${args.join(" ")}`, r.status);
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false });
  if (r.error) throw r.error;
  if (typeof r.status === "number" && r.status !== 0) {
    const err = new Error(`Command failed (${r.status}): ${cmd} ${args.join(" ")}`);
    err.stdout = r.stdout || "";
    err.stderr = r.stderr || "";
    throw err;
  }
  return String(r.stdout || "");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function touch(p) {
  if (!fs.existsSync(p)) fs.closeSync(fs.openSync(p, "a"));
}

function chmodBestEffort(p, mode) {
  try {
    fs.chmodSync(p, mode);
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function containerRunning(name = "ntfy") {
  try {
    const out = runCapture("docker", ["ps", "--format", "{{.Names}}"]);
    return out
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(name);
  } catch {
    return false;
  }
}

function dumpDiagnostics() {
  console.log("🧰 Dumping diagnostics...");
  try {
    run("docker", ["compose", "ps"]);
  } catch {}
  try {
    run("docker", ["logs", "--tail=200", "ntfy"]);
  } catch {}
  try {
    const fmt = "status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}";
    run("docker", ["inspect", "ntfy", "--format", fmt]);
  } catch {}
}

function listDir(dir) {
  console.log("📂 Show ntfy data dir:");
  console.log(dir);
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      const kind = e.isDirectory() ? "📁" : e.isSymbolicLink() ? "🔗" : "📄";
      console.log(`${kind} ${e.name}${e.isDirectory() ? "/" : ""} (${st.size}b)`);
    }
  } catch (e) {
    console.log("⚠️ Cannot list dir:", e?.message || e);
  }
}

function ensureSymlinkRepoDotNtfy(targetOutsideDir) {
  const linkPath = path.join(REPO, ".ntfy");

  if (fs.existsSync(linkPath)) {
    const st = fs.lstatSync(linkPath);

    // If already symlink, ok
    if (st.isSymbolicLink()) return;

    // If it's a real directory/file inside repo -> keep but warn
    // (If you want strict: you can remove it and create symlink)
    console.log("⚠️ .ntfy already exists in repo (not symlink). Keeping it.");
    return;
  }

  try {
    fs.symlinkSync(targetOutsideDir, linkPath, "dir");
    console.log(`🔗 Symlink created: .ntfy -> ${targetOutsideDir}`);
  } catch (e) {
    console.log("⚠️ Cannot create symlink (will fallback to repo .ntfy). Reason:", e?.message || e);
    // fallback: create real dir in repo
    ensureDir(linkPath);
  }
}

async function main() {
  console.log("🔎 Validate repo files...");
  existsOrDie("./docker-compose.yml", "❌ Missing docker-compose.yml");
  existsOrDie("./config/server.yml", "❌ Missing config/server.yml");

  // Choose outside writable workspace dir
  const OUT_ROOT =
    process.env.NTFY_WORKDIR ||
    process.env.PIPELINE_WORKSPACE ||
    process.env.AGENT_TEMPDIRECTORY ||
    process.env.BUILD_ARTIFACTSTAGINGDIRECTORY ||
    path.join(os.tmpdir(), "ntfy-workdir");

  const OUT_NTFY = path.join(OUT_ROOT, "ntfy-data");
  const OUT_ATTACH = path.join(OUT_NTFY, "attachments");
  const CACHE_DB = path.join(OUT_NTFY, "cache.db");
  const USER_DB = path.join(OUT_NTFY, "user.db");

  console.log("📁 Prepare ntfy data dir (outside repo) ...");
  ensureDir(OUT_ATTACH);

  console.log("🗃️ Ensure sqlite placeholders...");
  touch(CACHE_DB);
  touch(USER_DB);

  console.log("🔐 Best-effort permissions...");
  chmodBestEffort(CACHE_DB, 0o666);
  chmodBestEffort(USER_DB, 0o666);
  chmodBestEffort(OUT_NTFY, 0o777);
  chmodBestEffort(OUT_ATTACH, 0o777);

  console.log("🔗 Ensure repo .ntfy points to outside data (symlink) ...");
  ensureSymlinkRepoDotNtfy(OUT_NTFY);

  console.log("🐳 Pull & Up...");
  run("docker", ["compose", "pull"]);
  run("docker", ["compose", "up", "-d"]);

  console.log("📦 Container status right after up:");
  try {
    run("docker", ["compose", "ps"]);
  } catch {}

  console.log("🩺 Wait for ntfy health at /v1/health...");
  const healthUrl = `http://127.0.0.1:${NTFY_PORT}/v1/health`;
  let ok = false;

  for (let i = 1; i <= 60; i++) {
    try {
      const js = await fetchJson(healthUrl);
      if (js?.healthy === true) {
        ok = true;
        console.log("✅ ntfy is healthy");
        break;
      }
    } catch {}

    if (!containerRunning("ntfy")) {
      console.log("❌ Container ntfy is not running (crashed). Dumping diagnostics...");
      dumpDiagnostics();
      process.exit(1);
    }

    await sleep(2000);
  }

  if (!ok) {
    console.log("❌ Health not ready after retries. Dumping diagnostics...");
    dumpDiagnostics();
    process.exit(1);
  }

  console.log("📨 Smoke test publish (admin)...");
  const msg = `✅ ntfy up from Azure Pipeline build ${process.env.BUILD_BUILDID || ""}`.trim();

  try {
    const res = await fetch(`http://127.0.0.1:${NTFY_PORT}/pipeline-test`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(NTFY_ADMIN_USER, NTFY_ADMIN_PASS),
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: msg,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.log("❌ Smoke test publish failed.");
      console.log(`HTTP ${res.status}`);
      if (t) console.log(t);
      process.exit(1);
    }

    const txt = await res.text().catch(() => "");
    if (txt) console.log(txt);
  } catch (e) {
    console.log("❌ Smoke test publish error:", e?.message || e);
    process.exit(1);
  }

  listDir(OUT_NTFY);
}

main().catch((e) => {
  console.error("❌ Unhandled error:", e?.stack || e);
  dumpDiagnostics();
  process.exit(1);
});
