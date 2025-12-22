#!/usr/bin/env node
/**
 * Ensure nginx is installed.
 * - Check by running: nginx -v
 * - If missing:
 *   - Linux (Debian/Ubuntu): apt-get install nginx
 *   - Windows: choco install nginx
 *
 * Requirements:
 * - Linux install needs sudo/root on the agent
 * - Windows install needs Chocolatey
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return r;
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

function checkNginxVersion() {
  // nginx -v writes to stderr
  const r = run("nginx", ["-v"]);
  if (ok(r)) {
    const ver = (r.stderr || r.stdout || "").trim();
    return ver || "nginx present";
  }
  return null;
}

function ensureWindowsNginx() {
  const choco = run("choco", ["-v"]);
  if (!ok(choco)) {
    fail("Chocolatey (choco) not found. Cannot auto-install nginx on Windows.");
  }

  log("Installing nginx via Chocolatey...");
  const inst = run("choco", ["install", "nginx", "-y"], { stdio: "inherit" });
  if (!ok(inst)) {
    fail("Failed to install nginx via Chocolatey.");
  }
}

function hasCommand(cmd) {
  const whichCmd = isWindows() ? "where" : "which";
  const r = run(whichCmd, [cmd]);
  return ok(r);
}

function detectDebianBased() {
  // Heuristic: /etc/debian_version exists
  try {
    return fs.existsSync("/etc/debian_version");
  } catch {
    return false;
  }
}

function ensureLinuxNginx() {
  if (!detectDebianBased()) {
    fail("Auto-install supported only on Debian/Ubuntu (apt-get). This runner doesn't look Debian-based.");
  }

  const hasSudo = hasCommand("sudo");
  const aptGet = hasCommand("apt-get");
  if (!aptGet) {
    fail("apt-get not found. Cannot auto-install nginx on this Linux runner.");
  }

  const useSudo = hasSudo ? ["sudo"] : [];
  const cmd = useSudo.length ? useSudo[0] : "apt-get";
  const prefixArgs = useSudo.length ? [] : [];

  if (useSudo.length) {
    log("Updating apt repo (sudo apt-get update) ...");
    const up = run("sudo", ["apt-get", "update"], { stdio: "inherit" });
    if (!ok(up)) fail("apt-get update failed (sudo).");

    log("Installing nginx (sudo apt-get install -y nginx) ...");
    const inst = run("sudo", ["apt-get", "install", "-y", "nginx"], { stdio: "inherit" });
    if (!ok(inst)) fail("apt-get install nginx failed (sudo).");
  } else {
    warn("sudo not found. Trying apt-get directly (requires running as root) ...");

    log("Updating apt repo (apt-get update) ...");
    const up = run("apt-get", ["update"], { stdio: "inherit" });
    if (!ok(up)) fail("apt-get update failed.");

    log("Installing nginx (apt-get install -y nginx) ...");
    const inst = run("apt-get", ["install", "-y", "nginx"], { stdio: "inherit" });
    if (!ok(inst)) fail("apt-get install nginx failed.");
  }
}

async function main() {
  log(`Platform: ${process.platform} | Node: ${process.version}`);

  const ver = checkNginxVersion();
  if (ver) {
    log(`✅ nginx already installed: ${ver}`);
    process.exit(0);
  }

  warn("nginx not found (nginx -v failed). Attempting install...");

  if (isWindows()) {
    ensureWindowsNginx();
  } else if (isLinux()) {
    ensureLinuxNginx();
  } else {
    fail(`Unsupported platform: ${process.platform}`);
  }

  const ver2 = checkNginxVersion();
  if (!ver2) {
    fail("nginx still not available after install.");
  }
  log(`✅ nginx installed successfully: ${ver2}`);
}

main().catch((e) => fail(e?.message || String(e)));
