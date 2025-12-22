// js-scripts/keep-job-alive.js
// Nhiệm vụ:
// - Stream PM2 logs realtime (ALL apps hoặc 1 app)
// - Theo dõi PID của 1 app (mặc định: envListener). Nếu app stop => exit step
//
// ENV hỗ trợ:
//   WATCH_APP_NAME=envListener        (app để theo dõi sống/chết)
//   LOG_APP_NAME=__all__              (__all__ = log tất cả app; hoặc set tên app để log riêng app đó)
//   PM2_LOG_LINES=200
//   POLL_INTERVAL_MS=2000
//   USE_STDBUF=0|1                    (Linux only, nếu agent có stdbuf thì bật để ép line-buffer)
//   EXIT_CODE_ON_STOP=0               (mặc định exit 0 giống bash break; nếu muốn fail step thì set 1)

"use strict";

const { spawn } = require("child_process");

const WATCH_APP_NAME = process.env.WATCH_APP_NAME || "envListener";
const LOG_APP_NAME = process.env.LOG_APP_NAME || "__all__"; // "__all__" => pm2 logs (all)
const PM2_LOG_LINES = String(process.env.PM2_LOG_LINES || "200");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "2000");
const USE_STDBUF = String(process.env.USE_STDBUF || "0") === "1";
const EXIT_CODE_ON_STOP = Number(process.env.EXIT_CODE_ON_STOP || "0");

let logProc = null;
let stopping = false;

function isLinux() {
  return process.platform !== "win32" && process.platform !== "darwin";
}

function escapeShellArg(s) {
  // dùng cho bash -lc
  if (s === "") return "''";
  if (/[^A-Za-z0-9_/:=-]/.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
  return s;
}

function buildPm2LogsArgs() {
  // ✅ raw + timestamp để CI dễ đọc, tránh interactive mode
  const args = ["logs"];

  // LOG_APP_NAME="__all__" => không truyền appName => logs all
  // LOG_APP_NAME="<name>"  => logs riêng app đó
  if (LOG_APP_NAME && LOG_APP_NAME !== "__all__") {
    args.push(LOG_APP_NAME);
  }

  args.push("--lines", PM2_LOG_LINES, "--raw", "--timestamp");
  return args;
}

function spawnPm2Logs() {
  const pm2Args = buildPm2LogsArgs();

  if (USE_STDBUF && isLinux()) {
    // bash -lc "stdbuf -oL -eL pm2 logs ..."
    const cmd = `stdbuf -oL -eL pm2 ${pm2Args.map(escapeShellArg).join(" ")}`;
    logProc = spawn("bash", ["-lc", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  } else {
    logProc = spawn("pm2", pm2Args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  }

  logProc.stdout.setEncoding("utf8");
  logProc.stderr.setEncoding("utf8");

  // ✅ Pipe ra stdout/stderr để pipeline thấy realtime
  logProc.stdout.on("data", (chunk) => process.stdout.write(chunk));
  logProc.stderr.on("data", (chunk) => process.stderr.write(chunk));

  logProc.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`🛑 pm2 logs stream exited (code=${code}, signal=${signal})`);
      // Nếu muốn auto-restart stream logs khi pm2 logs tự chết:
      // setTimeout(() => !stopping && spawnPm2Logs(), 1000);
    }
  });

  logProc.on("error", (e) => {
    if (!stopping) console.error("❌ spawn pm2 logs error:", e);
  });
}

function getPm2Pid(appName) {
  return new Promise((resolve) => {
    let out = "";

    const p = spawn("pm2", ["pid", appName], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: process.env,
    });

    p.stdout.on("data", (d) => (out += d.toString()));

    const done = () => {
      // pm2 pid <name> có thể trả 0 hoặc nhiều dòng
      const firstLine =
        (out || "")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) || "";

      const pid = firstLine.replace(/[^\d]/g, "");
      resolve(pid || "0");
    };

    p.on("close", done);
    p.on("error", () => resolve("0"));
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function watchLoop() {
  console.log("📡 Streaming PM2 logs (realtime)...");
  console.log(`   - LOG_APP_NAME=${LOG_APP_NAME} (${LOG_APP_NAME === "__all__" ? "all apps" : "single app"})`);

  spawnPm2Logs();

  console.log(
    `👀 Watching ${WATCH_APP_NAME} (if it stops => end step)...\n` +
      `   - PM2_LOG_LINES=${PM2_LOG_LINES}\n` +
      `   - POLL_INTERVAL_MS=${POLL_INTERVAL_MS}\n` +
      `   - USE_STDBUF=${USE_STDBUF ? "1" : "0"}\n` +
      `   - EXIT_CODE_ON_STOP=${EXIT_CODE_ON_STOP}\n`
  );

  while (!stopping) {
    const pid = await getPm2Pid(WATCH_APP_NAME);

    if (!pid || pid === "0") {
      console.log(`🛑 ${WATCH_APP_NAME} stopped (pid=${pid || "empty"}) => exiting.`);
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  await cleanup();
  process.exit(EXIT_CODE_ON_STOP);
}

async function cleanup() {
  if (stopping) return;
  stopping = true;

  console.log("🧹 Stopping pm2 logs stream...");

  if (logProc && !logProc.killed) {
    try {
      logProc.kill("SIGTERM");
    } catch (_) {}
  }

  await sleep(300);

  if (logProc && !logProc.killed) {
    try {
      logProc.kill("SIGKILL");
    } catch (_) {}
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

process.on("exit", () => {
  if (!stopping) {
    try {
      logProc?.kill("SIGTERM");
    } catch (_) {}
  }
});

watchLoop().catch(async (e) => {
  console.error("❌ keep-job-alive error:", e);
  await cleanup();
  process.exit(1);
});
