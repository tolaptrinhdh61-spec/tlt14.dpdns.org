#!/usr/bin/env node
/**
 * setup-ssh.js (CI-hardened, background tunnels, default CWD)
 *
 * ✅ Goals:
 * - Write ~/.ssh/authorized_keys from PIPELINE_SSH_PUBKEY
 * - Linux:
 *   - Default USER-MODE: private sshd under ~/.ssh/ci-sshd, listen 127.0.0.1:<SSH_PORT>
 *   - Optional ROOT-MODE only when explicitly enabled AND sudo -n works (or root)
 * - Windows:
 *   - Setup OpenSSH Server (best-effort) + authorized_keys
 *
 * ✅ Improvements:
 * - Pinggy runs in BACKGROUND by default => step finishes => next steps run
 * - SSH session defaults to CI workspace directory (auto-detect) without YAML config
 * - NEW: SSH-J.com tunnel option
 *   - Auto username/namespace = <repo>-<runnerId> (sanitized)
 *   - Auto device name = <repo>-ci
 *   - Runs in background => step continues
 *   - Prints connect instructions + exports vars for next steps
 *
 * Required env:
 *   PIPELINE_SSH_PUBKEY=ssh-ed25519 AAAA...
 *
 * Optional env:
 *   SSH_PORT=2222                 (default 2222)
 *   SSH_MODE=auto|user|root       (default auto)
 *   SSH_ALLOW_USERS="vsts root"   (root-mode only)
 *
 * Optional toggles:
 *   SSH_DISABLE_FORCE_CWD=1       (disable auto-cd feature)
 *
 * Pinggy optional:
 *   PINGGY_ENABLE=1
 *   PINGGY_FOREGROUND=1
 *   PINGGY_TARGET_HOST=localhost
 *   PINGGY_TARGET_PORT=2222       (default SSH_PORT)
 *   PINGGY_REGION_HOST=a.pinggy.io
 *
 * SSH-J optional:
 *   SSHJ_ENABLE=1
 *   SSHJ_FOREGROUND=1
 *   SSHJ_HOST=ssh-j.com
 *   SSHJ_NAMESPACE=...            (override auto)
 *   SSHJ_DEVICE=...               (override auto)
 *   SSHJ_DEVICE_PORT=22           (virtual port on ssh-j side, default 22)
 *   SSHJ_LOCAL_HOST=localhost     (default localhost)
 *   SSHJ_LOCAL_PORT=2222          (default SSH_PORT)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

const isWindows = os.platform() === "win32";
const isLinux = os.platform() === "linux";

const CURRENT_USER = os.userInfo().username;
const HOME = os.homedir();

const SSH_PORT = String(process.env.SSH_PORT || "2222");
const SSH_MODE = String(process.env.SSH_MODE || "auto").toLowerCase();
const PIPELINE_SSH_PUBKEY = process.env.PIPELINE_SSH_PUBKEY;

const SSH_ALLOW_USERS = process.env.SSH_ALLOW_USERS || `${CURRENT_USER} root`;

// Auto detect “workspace/CWD of pipeline” without YAML config
function detectDefaultCwd() {
  const candidates = [
    process.env.SYSTEM_DEFAULTWORKINGDIRECTORY, // Azure DevOps
    process.env.BUILD_SOURCESDIRECTORY, // Azure DevOps
    process.env.BUILD_REPOSITORY_LOCALPATH, // Azure DevOps
    process.env.AGENT_BUILDDIRECTORY, // Azure DevOps
    process.env.GITHUB_WORKSPACE, // GitHub Actions
    process.cwd(),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return process.cwd();
}

const SSH_DEFAULT_CWD = process.env.SSH_DEFAULT_CWD || detectDefaultCwd();
const SSH_DISABLE_FORCE_CWD = String(process.env.SSH_DISABLE_FORCE_CWD || "") === "1";

const PATHS = isWindows
  ? {
      sshd_config: "C:\\ProgramData\\ssh\\sshd_config",
      ssh_dir: path.join(HOME, ".ssh"),
      authorized_keys: path.join(HOME, ".ssh", "authorized_keys"),
    }
  : {
      sshd_config: "/etc/ssh/sshd_config",
      ssh_dir: path.join(HOME, ".ssh"),
      authorized_keys: path.join(HOME, ".ssh", "authorized_keys"),
    };

// ───────────────────────────────────────────────────────
// 🧰 utils
// ───────────────────────────────────────────────────────
function log(msg) {
  process.stdout.write(msg + "\n");
}

function run(cmd, opts = {}) {
  log(`🔧 ${cmd}`);
  try {
    return execSync(cmd, { stdio: "inherit", ...opts });
  } catch (err) {
    if (opts.ignoreError) {
      log(`⚠️  Command failed (ignored): ${cmd}`);
      return null;
    }
    throw err;
  }
}

function runCapture(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  const check = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
  return !!runCapture(check);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    log(`✅ Created: ${p}`);
  }
}

function writeFileSafe(filePath, content, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode });
  log(`✅ Written: ${filePath}`);
}

function isRootOnLinux() {
  return isLinux && typeof process.getuid === "function" && process.getuid() === 0;
}

function execOk(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasSudoNoPass() {
  if (!isLinux) return false;
  return execOk("sudo -n true");
}

function spawnDetached(cmd, args, logFile) {
  log(`🚀 ${cmd} ${args.join(" ")}`);

  let outFd = null;
  let errFd = null;

  if (logFile) {
    ensureDir(path.dirname(logFile));
    outFd = fs.openSync(logFile, "a");
    errFd = fs.openSync(logFile, "a");
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", outFd ?? "ignore", errFd ?? "ignore"],
  });

  child.unref();

  try {
    if (typeof outFd === "number") fs.closeSync(outFd);
  } catch {}
  try {
    if (typeof errFd === "number") fs.closeSync(errFd);
  } catch {}

  return child.pid;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitPortLocalhost(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (commandExists("nc")) {
      if (execOk(`nc -vz 127.0.0.1 ${port} >/dev/null 2>&1`)) return true;
    } else if (commandExists("ss")) {
      const out = runCapture(`ss -lnt 2>/dev/null | grep ":${port} " || true`);
      if (out && out.trim()) return true;
    } else if (commandExists("netstat")) {
      const out = runCapture(`netstat -lnt 2>/dev/null | grep ":${port} " || true`);
      if (out && out.trim()) return true;
    }
    await sleep(250);
  }
  return false;
}

function isLikelyCI() {
  return !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.TF_BUILD || process.env.AGENT_ID || process.env.BUILD_BUILDID);
}

// Safe single-quote for bash -lc
function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function setPipelineVar(name, value) {
  const v = String(value ?? "");
  // Azure DevOps
  if (process.env.TF_BUILD) {
    log(`##vso[task.setvariable variable=${name}]${v}`);
  }
  // GitHub Actions
  if (process.env.GITHUB_ENV) {
    try {
      fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${v}\n`);
    } catch {}
  }
}

function sanitizeId(s, maxLen = 28) {
  const x = String(s || "")
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-") // keep a-z0-9_ . -
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  const trimmed = x.slice(0, maxLen);
  return trimmed || "ci";
}

function getRepoName() {
  // Azure DevOps
  const az = process.env.BUILD_REPOSITORY_NAME;
  if (az) return az;

  // GitHub: owner/repo
  const gh = process.env.GITHUB_REPOSITORY;
  if (gh && gh.includes("/")) return gh.split("/").pop();

  // fallback
  return path.basename(process.cwd());
}

function getRunnerId() {
  // Azure DevOps
  return (
    process.env.AGENT_ID ||
    process.env.BUILD_BUILDID ||
    process.env.BUILD_BUILDNUMBER ||
    // GitHub
    process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_NUMBER ||
    process.env.RUNNER_NAME ||
    // fallback
    Date.now().toString()
  );
}

function buildSshjDefaults() {
  const repo = sanitizeId(getRepoName(), 18);
  const rid = sanitizeId(getRunnerId(), 10);

  // ✅ theo yêu cầu: username/namespace = repo + runnerId
  const namespace = sanitizeId(`${repo}-${rid}`, 28);

  // device name: cố định theo repo cho dễ nhớ (không cần id)
  const device = sanitizeId(`${repo}-ci`, 24);

  return { repo, rid, namespace, device };
}

// ───────────────────────────────────────────────────────
// ✅ validate
// ───────────────────────────────────────────────────────
if (!PIPELINE_SSH_PUBKEY || !PIPELINE_SSH_PUBKEY.trim()) {
  log("❌ Missing env: PIPELINE_SSH_PUBKEY");
  process.exit(1);
}

log(`🔐 Current User: ${CURRENT_USER}`);
log(`🏠 Home Dir: ${HOME}`);
log(`🔌 SSH Port: ${SSH_PORT}`);
log(`🧭 SSH Mode: ${SSH_MODE}`);
log(`📂 Platform: ${isWindows ? "Windows" : "Linux"}`);
log(`📌 Default SSH CWD: ${SSH_DEFAULT_CWD}`);
log(`🧷 Force CWD: ${SSH_DISABLE_FORCE_CWD ? "OFF" : "ON"}`);

// ───────────────────────────────────────────────────────
// 🧾 authorized_keys
// ───────────────────────────────────────────────────────
ensureDir(PATHS.ssh_dir);
writeFileSafe(PATHS.authorized_keys, PIPELINE_SSH_PUBKEY.trim() + "\n", 0o600);

if (isLinux) {
  run(`chmod 700 "${PATHS.ssh_dir}"`, { ignoreError: true });
  run(`chmod 600 "${PATHS.authorized_keys}"`, { ignoreError: true });
  run(`chown -R ${CURRENT_USER}:${CURRENT_USER} "${PATHS.ssh_dir}"`, { ignoreError: true });
}

// ───────────────────────────────────────────────────────
// 🐧 Linux: USER-MODE sshd
// ───────────────────────────────────────────────────────
async function linuxUserMode() {
  if (!commandExists("sshd")) {
    log("📦 sshd not found. Trying to install openssh-server...");
    if (commandExists("apt-get")) {
      run("sudo -n apt-get update", { ignoreError: true });
      run("sudo -n apt-get install -y openssh-server", { ignoreError: true });
    } else {
      log("❌ No sshd and cannot auto-install (missing apt-get).");
      process.exit(1);
    }
  }

  const baseDir = path.join(HOME, ".ssh", "ci-sshd");
  const cfgPath = path.join(baseDir, "sshd_config");
  const pidPath = path.join(baseDir, "sshd.pid");
  const logPath = path.join(baseDir, "sshd.log");
  const hostKeyEd = path.join(baseDir, "ssh_host_ed25519_key");
  const hostKeyRsa = path.join(baseDir, "ssh_host_rsa_key");

  ensureDir(baseDir);

  if (!fs.existsSync(hostKeyEd)) run(`ssh-keygen -t ed25519 -f "${hostKeyEd}" -N ""`, { ignoreError: false });
  if (!fs.existsSync(hostKeyRsa)) run(`ssh-keygen -t rsa -b 2048 -f "${hostKeyRsa}" -N ""`, { ignoreError: false });

  run(`chmod 600 "${hostKeyEd}" "${hostKeyRsa}"`, { ignoreError: true });
  run(`chmod 644 "${hostKeyEd}.pub" "${hostKeyRsa}.pub"`, { ignoreError: true });

  const forceCwdBlock = SSH_DISABLE_FORCE_CWD
    ? ""
    : `
Match User ${CURRENT_USER}
  ForceCommand /bin/bash -lc ${shSingleQuote(
    `cd ${SSH_DEFAULT_CWD} && if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND"; else exec /bin/bash -l; fi`
  )}
`.trim() + "\n";

  const cfg =
    `
# Auto-generated (USER-MODE) by setup-ssh.js
Port ${SSH_PORT}
ListenAddress 127.0.0.1

PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
PrintMotd no
StrictModes no

AuthorizedKeysFile ${PATHS.authorized_keys}
AllowUsers ${CURRENT_USER}

PidFile ${pidPath}
HostKey ${hostKeyEd}
HostKey ${hostKeyRsa}

Subsystem sftp internal-sftp
LogLevel VERBOSE

${forceCwdBlock}
`.trim() + "\n";

  writeFileSafe(cfgPath, cfg, 0o600);
  run(`sshd -t -f "${cfgPath}"`, { ignoreError: false });

  if (fs.existsSync(pidPath)) {
    const oldPid = fs.readFileSync(pidPath, "utf8").trim();
    if (oldPid) run(`kill ${oldPid}`, { ignoreError: true });
  }

  const sshdBin = commandExists("/usr/sbin/sshd") ? "/usr/sbin/sshd" : "sshd";
  const pid = spawnDetached(sshdBin, ["-f", cfgPath, "-E", logPath], null);

  log(`✅ Linux USER-MODE sshd started (pid=${pid})`);
  log(`🪵 sshd log: ${logPath}`);

  const ok = await waitPortLocalhost(SSH_PORT, 10000);
  if (!ok) {
    log(`❌ sshd is NOT listening on 127.0.0.1:${SSH_PORT}`);
    const tail = runCapture(`tail -n 120 "${logPath}" 2>/dev/null || true`);
    if (tail) process.stdout.write(tail);
    process.exit(1);
  }

  log(`✅ sshd listening on 127.0.0.1:${SSH_PORT}`);
  return { mode: "user-mode", sshdLog: logPath, baseDir };
}

// ───────────────────────────────────────────────────────
// 🐧 Linux: ROOT-MODE
// ───────────────────────────────────────────────────────
async function linuxRootMode() {
  if (!(isRootOnLinux() || hasSudoNoPass())) {
    log("❌ ROOT-MODE requested but no root / no passwordless sudo.");
    process.exit(1);
  }

  const forceCwdBlock = SSH_DISABLE_FORCE_CWD
    ? ""
    : `
Match User ${CURRENT_USER}
  ForceCommand /bin/bash -lc ${shSingleQuote(
    `cd ${SSH_DEFAULT_CWD} && if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/bash -lc "$SSH_ORIGINAL_COMMAND"; else exec /bin/bash -l; fi`
  )}
`.trim() + "\n";

  const cfg =
    `
# Auto-generated (ROOT-MODE) by setup-ssh.js
Port ${SSH_PORT}
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers ${SSH_ALLOW_USERS}
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp

${forceCwdBlock}
`.trim() + "\n";

  const tmp = path.join(os.tmpdir(), `sshd_config_${Date.now()}.tmp`);
  fs.writeFileSync(tmp, cfg, { encoding: "utf8" });

  if (isRootOnLinux()) {
    run(`cp "${tmp}" "${PATHS.sshd_config}"`, { ignoreError: false });
    run(`chmod 644 "${PATHS.sshd_config}"`, { ignoreError: true });
  } else {
    run(`sudo -n bash -lc 'cat "${tmp}" > "${PATHS.sshd_config}"'`, { ignoreError: false });
    run(`sudo -n chmod 644 "${PATHS.sshd_config}"`, { ignoreError: true });
  }

  run(`${isRootOnLinux() ? "" : "sudo -n "}service ssh restart || ${isRootOnLinux() ? "" : "sudo -n "}service sshd restart`, { ignoreError: true });
  run(`${isRootOnLinux() ? "" : "sudo -n "}systemctl restart sshd || ${isRootOnLinux() ? "" : "sudo -n "}systemctl restart ssh`, {
    ignoreError: true,
  });

  const ok = await waitPortLocalhost(SSH_PORT, 10000);
  if (!ok) {
    log(`❌ ROOT-MODE applied but sshd is NOT listening on 127.0.0.1:${SSH_PORT}`);
    process.exit(1);
  }

  log(`✅ Linux ROOT-MODE sshd listening on 127.0.0.1:${SSH_PORT}`);
  return { mode: "root-mode" };
}

// ───────────────────────────────────────────────────────
// 🪟 Windows (best-effort)
// ───────────────────────────────────────────────────────
function windowsSetup() {
  const checkCmd = 'Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*" | Select-Object -ExpandProperty State';
  const state = runCapture(`powershell -Command "${checkCmd}"`);

  if (!state || state.trim() !== "Installed") {
    log("📦 Installing OpenSSH Server on Windows...");
    run('powershell -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0"', { ignoreError: false });
  }

  run('powershell -Command "Set-Service -Name sshd -StartupType Automatic"', { ignoreError: true });
  run('powershell -Command "Start-Service sshd"', { ignoreError: true });

  const cfg =
    `
# Auto-generated by setup-ssh.js
Port ${SSH_PORT}
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers ${SSH_ALLOW_USERS}
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp sftp-server.exe
`.trim() + "\n";

  writeFileSafe(PATHS.sshd_config, cfg, 0o644);

  run(
    `powershell -Command "New-NetFirewallRule -Name sshd-${SSH_PORT} -DisplayName 'OpenSSH Server Port ${SSH_PORT}' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort ${SSH_PORT}"`,
    { ignoreError: true }
  );

  run("net stop sshd", { ignoreError: true });
  run("net start sshd", { ignoreError: true });

  log("✅ Windows sshd configured (best-effort)");
  return { mode: "windows" };
}

// ───────────────────────────────────────────────────────
// 🚇 Pinggy (optional) - background by default
// ───────────────────────────────────────────────────────
async function startPinggyBackground(baseDirForLogs) {
  const enable = String(process.env.PINGGY_ENABLE || "").trim() === "1";
  if (!enable) return { started: false };

  const foreground = String(process.env.PINGGY_FOREGROUND || "").trim() === "1";
  const targetHost = process.env.PINGGY_TARGET_HOST || "localhost";
  const targetPort = process.env.PINGGY_TARGET_PORT || SSH_PORT;
  const pinggyHost = process.env.PINGGY_REGION_HOST || "a.pinggy.io";

  if (!commandExists("ssh")) {
    log("❌ ssh client not found; cannot start Pinggy.");
    process.exit(1);
  }

  const logDir = baseDirForLogs || path.join(HOME, ".ssh");
  ensureDir(logDir);

  const pinggyLog = path.join(logDir, "pinggy.log");
  const pinggyPidFile = path.join(logDir, "pinggy.pid");

  const args = [
    "-p",
    "443",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    `-R0:${targetHost}:${targetPort}`,
    `tcp@${pinggyHost}`,
  ];

  log("🚇 Starting Pinggy tunnel...");
  log("📌 Expect endpoint like: tcp://*.pinggy.link:PORT");

  if (foreground) {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return { started: true, foreground: true };
  }

  const pid = spawnDetached("ssh", args, pinggyLog);
  fs.writeFileSync(pinggyPidFile, String(pid), "utf8");
  log(`✅ Pinggy started in background (pid=${pid})`);
  log(`🪵 Pinggy log: ${pinggyLog}`);

  let endpoint = null;
  const start = Date.now();

  while (Date.now() - start < 8000) {
    try {
      const txt = fs.readFileSync(pinggyLog, "utf8");
      const m = txt.match(/tcp:\/\/[^\s]+/);
      if (m) {
        endpoint = m[0];
        break;
      }
    } catch {}
    await sleep(250);
  }

  if (endpoint) {
    log(`📌 Pinggy endpoint: ${endpoint}`);
    setPipelineVar("PINGGY_ENDPOINT", endpoint);
  } else {
    log("⚠️  Endpoint not detected yet. Check pinggy.log to copy tcp://...");
  }

  return { started: true, foreground: false, pid, endpoint };
}

// ───────────────────────────────────────────────────────
// 🚇 SSH-J.com (optional) - background by default
// ───────────────────────────────────────────────────────
async function startSshJBackground(baseDirForLogs) {
  const enable = String(process.env.SSHJ_ENABLE || "").trim() === "1";
  if (!enable) return { started: false };

  const foreground = String(process.env.SSHJ_FOREGROUND || "").trim() === "1";
  const sshjHost = process.env.SSHJ_HOST || "ssh-j.com";

  const defaults = buildSshjDefaults();

  const namespace = sanitizeId(process.env.SSHJ_NAMESPACE || defaults.namespace, 28);
  const device = sanitizeId(process.env.SSHJ_DEVICE || defaults.device, 24);

  const devicePort = String(process.env.SSHJ_DEVICE_PORT || "22"); // port label on ssh-j side
  const localHost = process.env.SSHJ_LOCAL_HOST || "localhost";
  const localPort = String(process.env.SSHJ_LOCAL_PORT || SSH_PORT); // your sshd port inside runner

  if (!commandExists("ssh")) {
    log("❌ ssh client not found; cannot start SSH-J tunnel.");
    process.exit(1);
  }

  const logDir = baseDirForLogs || path.join(HOME, ".ssh");
  ensureDir(logDir);

  const sshjLog = path.join(logDir, "sshj.log");
  const sshjPidFile = path.join(logDir, "sshj.pid");

  const publishArgs = [
    `${namespace}@${sshjHost}`,
    "-N",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `${device}:${devicePort}:${localHost}:${localPort}`,
  ];

  const publishCmdPretty = `ssh ${namespace}@${sshjHost} -N -R ${device}:${devicePort}:${localHost}:${localPort}`;

  log("🚇 Starting SSH-J.com publish...");
  log(`📌 SSH-J publish: ${publishCmdPretty}`);

  setPipelineVar("SSHJ_HOST", sshjHost);
  setPipelineVar("SSHJ_NAMESPACE", namespace);
  setPipelineVar("SSHJ_DEVICE", device);
  setPipelineVar("SSHJ_DEVICE_PORT", devicePort);

  if (foreground) {
    const child = spawn("ssh", publishArgs, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return { started: true, foreground: true };
  }

  const pid = spawnDetached("ssh", publishArgs, sshjLog);
  fs.writeFileSync(sshjPidFile, String(pid), "utf8");
  log(`✅ SSH-J started in background (pid=${pid})`);
  log(`🪵 SSH-J log: ${sshjLog}`);

  // Help text for user
  const connect1 = `ssh -J ${namespace}@${sshjHost} ${CURRENT_USER}@${device}`;
  const connect2 = `ssh -i <private-key> -J ${namespace}@${sshjHost} ${CURRENT_USER}@${device}`;

  log("🧭 Connect from your PC:");
  log(`👉 ${connect1}`);
  log(`👉 ${connect2}`);

  setPipelineVar("SSHJ_CONNECT", connect1);

  return { started: true, foreground: false, pid, namespace, device, connect1 };
}

// ───────────────────────────────────────────────────────
// 🌐 Persist SSH URLs to Realtime DB (optional via curl)
// ───────────────────────────────────────────────────────
function joinUrl(base, ...parts) {
  let u = String(base || "").trim();
  if (!u) return "";
  u = u.replace(/\/+$/g, "");
  const tail = parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return tail ? `${u}/${tail}` : u;
}

function buildRtdbUrl(base, id) {
  // Accept:
  // - base = https://xxx.firebaseio.com/ssh_urls           => append /<id>.json
  // - base = https://xxx.firebaseio.com/ssh_urls.json?auth=... => append /<id>.json before query
  const b = String(base || "").trim();
  const i = encodeURIComponent(String(id || "").trim());
  if (!b || !i) return "";

  if (b.includes(".json")) {
    // split at first ".json"
    const idx = b.indexOf(".json");
    const before = b.slice(0, idx); // .../ssh_urls
    const after = b.slice(idx + 5); // maybe "?auth=..."
    return `${joinUrl(before, i)}.json${after}`;
  }

  return `${joinUrl(b, i)}.json`;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(t) };
}
function sanitizeUrl(raw) {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);

  // remove BOM + trim whitespace/newlines
  s = s.replace(/^\uFEFF/, "").trim();

  // remove surrounding quotes if present: "..." or '...'
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  // remove trailing escaped newlines if someone accidentally included "\n" literally
  // (rare, but happens when JSON stores "\\n")
  s = s.replace(/(\\r\\n|\\n|\\r)+$/g, "").trim();

  // remove real trailing CR/LF (already covered by trim, but keep for safety)
  s = s.replace(/[\r\n]+$/g, "");

  return s;
}

/**
 * PATCH JSON via fetch (Node 18+)
 * @param {string} url
 * @param {object} obj
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<boolean>}
 */
async function fetchPatchJson(url, obj, opts = {}) {
  url = sanitizeUrl(url);
  const timeoutMs = Number(opts.timeoutMs ?? process.env.ENV_JSON_TIMEOUT_MS ?? 15000);

  const body = JSON.stringify(obj);

  log(`📡 Persisting SSH URLs via fetch PATCH => ${maskAuthInUrl(url)}`);

  const { controller, clear } = withTimeout(timeoutMs);

  try {
    if (typeof fetch !== "function") {
      log("❌ fetch() is not available. Need Node 18+.");
      return false;
    }

    const headers = {
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // try read response text for debugging (kept short)
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      txt = (txt || "").slice(0, 500);

      log(`⚠️  fetch PATCH failed: HTTP ${res.status} ${res.statusText}${txt ? ` | body: ${txt}` : ""}`);
      return false;
    }

    log("✅ Persisted SSH URLs to RTDB");
    return true;
  } catch (e) {
    const msg = e?.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : e?.message || String(e);
    log(`⚠️  fetch PATCH error: ${msg}`);
    return false;
  } finally {
    clear();
  }
}
function maskAuthInUrl(u) {
  const s = String(u || "");
  if (!s) return s;
  // replace auth=... in query string
  return s.replace(/([?&]auth=)[^&#]*/gi, "$1****");
}

function sendNtfyLine({ topic, title, line }) {
  const base = String(process.env.NTFY_URL || "https://ntfy.sh")
    .trim()
    .replace(/\/+$/g, "");
  const t = String(topic || "").trim();
  const ttl = String(title || "").trim();
  const msg = String(line || "").trim();

  if (!t || !ttl || !msg) return false;

  if (!commandExists("curl")) {
    log("⚠️  curl not found => skip ntfy publish.");
    return false;
  }

  const url = `${base}/${encodeURIComponent(t)}`;

  // ✅ Gửi dạng text + header (gọn, copy dễ)
  // ✅ -o /dev/null: không in body response
  // ✅ -sS: silent nhưng vẫn báo lỗi
  const args = [
    "-sS",
    "-o",
    "/dev/null",
    "-X",
    "POST",
    url,
    "-H",
    `X-Title: ${ttl}`,
    "-H",
    "X-Priority: 3",
    "-H",
    "Content-Type: text/plain; charset=utf-8",
    "--data-binary",
    msg,
  ];

  log(`📣 ntfy => ${base}/${t} | ${ttl}`);
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("curl", args, { stdio: "inherit" });
    if (r.status !== 0) {
      log(`⚠️  ntfy publish failed (exit=${r.status})`);
      return false;
    }
    return true;
  } catch (e) {
    log(`⚠️  ntfy publish error: ${e?.message || e}`);
    return false;
  }
}
function notifySshUrlsToNtfy({ sshjConnect, pinggyEndpoint, envId }) {
  const topic = "ongtrieuhau-host-ssh";

  if (sshjConnect) {
    sendNtfyLine({ topic, title: "🌐 SSHJ_CONNECT", line: sshjConnect });
  }
  if (pinggyEndpoint) {
    sendNtfyLine({ topic, title: "🌐 PINGGY_ENDPOINT", line: pinggyEndpoint });
  }
  if (envId) {
    sendNtfyLine({ topic, title: "🧩 ENV_SSH_URLS_ID", line: envId });
  }
}
async function persistSshUrlsIfNeeded({ sshjConnect, pinggyEndpoint }) {
  const base = String(process.env.ENV_SSH_URLS || "").trim();
  const id = String(process.env.ENV_SSH_URLS_ID || "").trim();

  if (!base || !id) {
    log("ℹ️  ENV_SSH_URLS / ENV_SSH_URLS_ID missing => skip persisting SSH URLs.");
    return;
  }

  const payload = {};
  if (sshjConnect) payload.SSHJ_CONNECT = sshjConnect;
  if (pinggyEndpoint) payload.PINGGY_ENDPOINT = pinggyEndpoint;

  if (Object.keys(payload).length === 0) {
    log("ℹ️  No SSHJ_CONNECT / PINGGY_ENDPOINT to persist => skip.");
    return;
  }

  payload.updatedAt = new Date().toISOString();

  const url = buildRtdbUrl(base, id);
  if (!url) {
    log("⚠️  Failed to build RTDB URL => skip persisting.");
    return;
  }

  // keep actual url (with auth) for request
  await fetchPatchJson(url, payload);
}

// ───────────────────────────────────────────────────────
// ▶️ main
// ───────────────────────────────────────────────────────
(async () => {
  let mode = "n/a";
  let baseDirForLogs = null;

  // ✅ capture these for RTDB persist
  let pinggyEndpoint = null;
  let sshjConnect = null;

  if (isLinux) {
    if (SSH_MODE === "root") {
      const r = await linuxRootMode();
      mode = r.mode;
    } else {
      const r = await linuxUserMode();
      mode = r.mode;
      baseDirForLogs = r.baseDir;
    }

    log(`🧭 Linux mode: ${mode}`);
    log(`🔌 Local test: ssh -p ${SSH_PORT} ${CURRENT_USER}@127.0.0.1 -i <private-key>`);
  } else if (isWindows) {
    const r = windowsSetup();
    mode = r.mode;
    log(`🧭 Windows mode: ${mode}`);
  } else {
    log("❌ Unsupported platform: " + os.platform());
    process.exit(1);
  }

  // Tunnels (enable whichever you want via env)
  const pinggyRes = await startPinggyBackground(baseDirForLogs);
  if (pinggyRes?.endpoint) pinggyEndpoint = pinggyRes.endpoint;

  const sshjRes = await startSshJBackground(baseDirForLogs);
  if (sshjRes?.connect1) sshjConnect = sshjRes.connect1;

  // ✅ Persist to RTDB if ENV_SSH_URLS + ENV_SSH_URLS_ID exist
  log(`🌐 sshjConnect: ${sshjConnect}`);
  log(`🌐 pinggyEndpoint: ${pinggyEndpoint}`);
  await persistSshUrlsIfNeeded({ sshjConnect, pinggyEndpoint });

  // ✅ Notify via ntfy (best-effort, no fail)
  try {
    notifySshUrlsToNtfy({
      sshjConnect,
      pinggyEndpoint,
      envId: process.env.ENV_SSH_URLS_ID, // optional
    });
  } catch {}

  log(`
✅ SSH setup completed!

🧪 Verify files:
   ${isWindows ? "type" : "cat"} ${PATHS.authorized_keys}
   ${isLinux ? `   cat ~/.ssh/ci-sshd/sshd_config` : ""}

🪵 Logs:
   Linux (user-mode): tail -n 200 ~/.ssh/ci-sshd/sshd.log
   Pinggy: tail -n 200 ~/.ssh/ci-sshd/pinggy.log  (or ~/.ssh/pinggy.log)
   SSH-J:  tail -n 200 ~/.ssh/ci-sshd/sshj.log    (or ~/.ssh/sshj.log)

🧷 Exported vars (for next steps):
   PINGGY_ENDPOINT (if Pinggy enabled)
   SSHJ_NAMESPACE, SSHJ_DEVICE, SSHJ_CONNECT (if SSH-J enabled)
`);
})();
