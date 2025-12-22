#!/usr/bin/env node
/**
 * Ensure cloudflared is available on PATH.
 * - Check: cloudflared --version
 * - If missing: download official binary (latest) to ./.tools/bin/
 * - Persist PATH for next steps:
 *   - GitHub Actions: write to GITHUB_PATH
 *   - Azure Pipelines: ##vso[task.prependpath]
 *
 * Works on: Windows + Linux (also supports macOS if needed)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function ok(r) {
  return r && r.status === 0;
}

function log(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stderr.write("⚠️ " + msg + "\n");
}
function fail(msg, code = 1) {
  process.stderr.write("❌ " + msg + "\n");
  process.exit(code);
}

function isWindows() {
  return process.platform === "win32";
}
function isLinux() {
  return process.platform === "linux";
}
function isMac() {
  return process.platform === "darwin";
}

function isLikelyGitHub() {
  return Boolean(process.env.GITHUB_PATH);
}
function isLikelyAzure() {
  const v = (process.env.TF_BUILD || "").toLowerCase();
  return v === "true" || v === "1";
}

function checkCloudflaredVersion() {
  // cloudflared --version usually prints to stdout
  const r = run("cloudflared", ["--version"]);
  if (ok(r)) {
    const out = (r.stdout || r.stderr || "").trim();
    return out || "cloudflared present";
  }
  return null;
}

function getDownloadUrl() {
  const arch = process.arch; // x64, arm64, ia32...
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";

  if (isWindows()) {
    if (arch === "x64") return `${base}/cloudflared-windows-amd64.exe`;
    if (arch === "arm64") return `${base}/cloudflared-windows-arm64.exe`;
    // fallback
    return `${base}/cloudflared-windows-amd64.exe`;
  }

  if (isLinux()) {
    if (arch === "x64") return `${base}/cloudflared-linux-amd64`;
    if (arch === "arm64") return `${base}/cloudflared-linux-arm64`;
    // fallback
    return `${base}/cloudflared-linux-amd64`;
  }

  if (isMac()) {
    if (arch === "x64") return `${base}/cloudflared-darwin-amd64.tgz`;
    if (arch === "arm64") return `${base}/cloudflared-darwin-amd64.tgz`; // cloudflare commonly ships tgz; mac handling is optional
    return `${base}/cloudflared-darwin-amd64.tgz`;
  }

  return null;
}

async function downloadToFile(url, outFile) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() is not available. Use Node 18+.");
  }

  const res = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("Downloaded file is empty.");

  fs.writeFileSync(outFile, buf);
}

function ensureExecutable(filePath) {
  if (!isWindows()) {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {}
  }
}

function prependPathPersist(dir) {
  // make available immediately in current process
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ""}`;

  // persist to next steps
  if (isLikelyGitHub() && process.env.GITHUB_PATH) {
    fs.appendFileSync(process.env.GITHUB_PATH, dir + "\n", "utf8");
    log(`✅ Added to GitHub PATH: ${dir}`);
    return;
  }

  if (isLikelyAzure()) {
    // Azure Pipelines logging command
    process.stdout.write(`##vso[task.prependpath]${dir}\n`);
    log(`✅ Added to Azure PATH: ${dir}`);
    return;
  }

  warn(`Not GitHub/Azure detected. PATH updated only for current process. Add this dir to PATH manually: ${dir}`);
}

async function main() {
  log(`Platform: ${process.platform} | Arch: ${process.arch} | Node: ${process.version}`);

  const ver = checkCloudflaredVersion();
  if (ver) {
    log(`✅ cloudflared already installed: ${ver}`);
    process.exit(0);
  }

  warn("cloudflared not found (cloudflared --version failed). Installing portable binary...");

  const url = getDownloadUrl();
  if (!url) {
    fail(`Unsupported platform for auto-install: ${process.platform}/${process.arch}`);
  }

  const toolsDir = path.resolve(process.cwd(), ".tools", "bin");
  fs.mkdirSync(toolsDir, { recursive: true });

  const exeName = isWindows() ? "cloudflared.exe" : "cloudflared";
  const outFile = path.join(toolsDir, exeName);

  log(`Downloading: ${url}`);
  await downloadToFile(url, outFile);
  ensureExecutable(outFile);

  // Ensure tool dir on PATH for next steps
  prependPathPersist(toolsDir);

  // Verify using absolute path first (more reliable)
  const rAbs = run(outFile, ["--version"]);
  if (!ok(rAbs)) {
    fail(`cloudflared downloaded but failed to run: ${rAbs.stderr || rAbs.stdout || ""}`.trim());
  }

  // Verify PATH call too (so next scripts can call "cloudflared")
  const ver2 = checkCloudflaredVersion();
  if (!ver2) {
    warn("cloudflared runs by absolute path but not found on PATH yet in this step. Next steps should see it after prependpath.");
    log(`✅ cloudflared installed at: ${outFile}`);
    process.exit(0);
  }

  log(`✅ cloudflared installed successfully: ${ver2}`);
}

main().catch((e) => fail(e?.message || String(e)));
