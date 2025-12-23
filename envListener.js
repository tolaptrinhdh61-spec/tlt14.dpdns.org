// envListener.js
// Chạy trực tiếp: node envListener.js [SERVICE_ACCOUNT_BASE64_ENV_KEY]
//
// Nhiệm vụ:
// - Lắng nghe Firebase RTDB (/config mặc định)
// - Bỏ qua callback đầu tiên (snapshot ban đầu) => KHÔNG update/restart
// - Khi dữ liệu thay đổi thật sự (process.env khác) => update ENV (.env + process.env + GitHub/Azure export nếu có)
// - Nếu ENV thay đổi => restart PM2 tuần tự (sequential)
//
// Chế độ “1 instance active” (khóa chạy):
// - Khi envListener start => sinh instanceId + ghi activeInstanceId lên Firebase (runtime path riêng)
// - Instance khác đang chạy thấy activeInstanceId đổi => tự shutdown + process.exit() (để dừng job/pipeline nếu muốn)
// - Nếu chạy dưới PM2: khi bị takeover sẽ tự "pm2 stop envListener" để PM2 không autorestart nữa
//
// ENV hỗ trợ:
// - ENV_LISTENER_FB_SERVICES_ACCOUNT_BASE64 : base64 của serviceAccount.json (mặc định dùng key này)
//   hoặc truyền KEY qua argv[2]: node envListener.js <KEY_NAME>
//
// - ENV_LISTENER_FB_PATH                 : path chứa config env trên RTDB (default: /config)
// - ENV_FILE_PATH                        : đường dẫn file .env (default: .env)
//
// - ENV_LISTENER_RESTART_APPS            : danh sách PM2 apps cần restart, CSV
//   ví dụ: "nginx,cloudflared"  (restart tuần tự)
//
// - ENV_LISTENER_RUNTIME_PATH            : base path runtime cho listener (default: <ENV_LISTENER_FB_PATH>/__env_listener)
//   runtime sẽ chứa:
//   + <runtime>/activeInstanceId
//   + <runtime>/instances/<instanceId>...
//
// - ENV_LISTENER_EXIT_CODE_ON_TAKEOVER   : exit code khi bị instance khác takeover (default: 0)
//   gợi ý: set = 1 để fail job và dừng các step phía sau (GitHub Actions/Azure Pipelines)
//
// Detect CI:
// - GitHub Actions: có GITHUB_ENV
// - Azure Pipelines: có SYSTEM_TEAMFOUNDATIONCOLLECTIONURI

const admin = require("firebase-admin");
const os = require("os");
const { execSync } = require("child_process");

const { restartPM2Apps } = require("./js-scripts/helpers/pm2Restart");

function normalizeBase64(input) {
  if (!input || typeof input !== "string") return "";
  let s = input.trim();
  if (s.toLowerCase().startsWith("base64:")) s = s.slice(7).trim();
  s = s.replace(/\s+/g, "");
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const mod = s.length % 4;
  if (mod === 2) s += "==";
  else if (mod === 3) s += "=";
  return s;
}

function decodeServiceAccountFromEnv(envKey) {
  const raw = process.env[envKey];
  if (!raw) {
    throw new Error(`Missing env var: ${envKey} (must contain base64 of serviceAccount.json)`);
  }

  const b64 = normalizeBase64(raw);
  const jsonText = Buffer.from(b64, "base64").toString("utf8");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Decoded ${envKey} is not valid JSON: ${e.message}`);
  }

  if (!serviceAccount.project_id) {
    throw new Error(`serviceAccount JSON missing "project_id"`);
  }

  return serviceAccount;
}

function initFirebase(serviceAccount) {
  const projectId = serviceAccount.project_id;

  let app;
  try {
    app = admin.app(projectId);
  } catch {
    app = admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        databaseURL: serviceAccount.databaseURL || `https://${projectId}-default-rtdb.asia-southeast1.firebasedatabase.app`,
      },
      projectId
    );
  }

  return { app, projectId };
}

function makeInstanceId() {
  const rand = Math.random().toString(16).slice(2);
  return `inst_${Date.now()}_${process.pid}_${rand}`;
}

function joinPath(base, sub) {
  const b = (base || "").trim();
  const s = (sub || "").trim();
  const x = (b.endsWith("/") ? b.slice(0, -1) : b) || "";
  const y = (s.startsWith("/") ? s.slice(1) : s) || "";
  return `/${[x.replace(/^\//, ""), y].filter(Boolean).join("/")}`;
}

function parseCsv(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function tryPm2StopSelf() {
  try {
    execSync("pm2 stop envListener", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * startEnvListener(serviceAccountB64EnvKey, options)
 * - returns runner with stop/shutdown
 */
function startEnvListener(serviceAccountB64EnvKey, options = {}) {
  const firebasePath = options.firebasePath || process.env.ENV_LISTENER_FB_PATH || "/config";
  const envFilePath = options.envFilePath || process.env.ENV_FILE_PATH || ".env";

  const pm2Apps = options.pm2Apps || (process.env.ENV_LISTENER_RESTART_APPS ? parseCsv(process.env.ENV_LISTENER_RESTART_APPS) : []);

  // runtime path (tách riêng khỏi /config để không đụng data ENV)
  const runtimeBase = options.runtimePath || process.env.ENV_LISTENER_RUNTIME_PATH || joinPath(firebasePath, "__env_listener");

  const activeIdPath = joinPath(runtimeBase, "activeInstanceId");
  const instancesPath = joinPath(runtimeBase, "instances");

  const serviceAccount = decodeServiceAccountFromEnv(serviceAccountB64EnvKey);
  const { app, projectId } = initFirebase(serviceAccount);

  const instanceId = makeInstanceId();
  const hostname = os.hostname();

  console.log("🚀 ENV Listener started\n");
  console.log("Configuration:");
  console.log(`  - SA Base64 ENV Key: ${serviceAccountB64EnvKey}`);
  console.log(`  - ProjectId: ${projectId}`);
  console.log(`  - Firebase Path: ${firebasePath}`);
  console.log(`  - Runtime Base: ${runtimeBase}`);
  console.log(`  - ActiveId Path: ${activeIdPath}`);
  console.log(`  - ENV File: ${envFilePath}`);
  console.log(`  - PM2 Apps: ${Array.isArray(pm2Apps) && pm2Apps.length ? pm2Apps.join(", ") : "None"}`);
  console.log(`  - InstanceId: ${instanceId}`);
  console.log(`  - Hostname: ${hostname}`);
  console.log(`  - GitHub Actions: ${process.env.GITHUB_ENV ? "Yes" : "No"}`);
  console.log(`  - Azure Pipeline: ${process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ? "Yes" : "No"}`);
  console.log("");

  const envRef = app.database().ref(firebasePath);
  const activeIdRef = app.database().ref(activeIdPath);
  const instanceRef = app.database().ref(joinPath(instancesPath, instanceId));

  let isFirstEnvSnapshot = true;
  let isFirstActiveIdSnapshot = true;
  let exiting = false;

  const safeExit = async (code = 0, reason = "") => {
    if (exiting) return;
    exiting = true;

    if (reason) console.log(`\n🧨 Exit requested: ${reason}`);

    try {
      envRef.off();
      activeIdRef.off();
    } catch {}

    try {
      await instanceRef.update({
        stoppedAt: admin.database.ServerValue.TIMESTAMP,
        status: "stopped",
      });
    } catch {}

    try {
      await admin.app(projectId).delete();
    } catch {}

    process.exit(code);
  };

  // ✅ 1) Register instance + set activeInstanceId
  (async () => {
    try {
      await instanceRef.set({
        instanceId,
        pid: process.pid,
        hostname,
        startedAt: admin.database.ServerValue.TIMESTAMP,
        status: "running",
      });

      try {
        instanceRef.onDisconnect().update({
          stoppedAt: admin.database.ServerValue.TIMESTAMP,
          status: "disconnected",
        });
      } catch {}

      await activeIdRef.set(instanceId);

      console.log(`🪪 Registered instance & set activeInstanceId = ${instanceId}`);
    } catch (e) {
      console.error("❌ Failed to register active instance:", e.message);
      await safeExit(1, "cannot register active instance");
    }
  })();

  // ✅ 2) Watch activeInstanceId: nếu đổi sang id khác => thoát
  activeIdRef.on(
    "value",
    (snap) => {
      const activeId = snap.val();

      if (isFirstActiveIdSnapshot) {
        isFirstActiveIdSnapshot = false;
        console.log(`👑 Active instance observed: ${activeId || "(null)"}`);
        return;
      }

      if (activeId && activeId !== instanceId) {
        console.log(`⚠️  Another instance took over: ${activeId} (current: ${instanceId})`);

        // ✅ Nếu chạy dưới PM2 + autorestart, cần stop chính mình để PM2 không bật lại
        const stopped = tryPm2StopSelf();
        if (stopped) console.log("🛑 PM2 stop envListener (prevent autorestart).");

        const exitCode = process.env.ENV_LISTENER_EXIT_CODE_ON_TAKEOVER ? Number(process.env.ENV_LISTENER_EXIT_CODE_ON_TAKEOVER) : 0;

        safeExit(exitCode, "taken over by another instance");
      }
    },
    (err) => console.error("❌ ActiveId listener error:", err.message)
  );

  // ✅ 3) Watch ENV config path: bỏ qua snapshot đầu tiên
  const onEnvValue = async (snapshot) => {
    const data = snapshot.val();

    if (isFirstEnvSnapshot) {
      isFirstEnvSnapshot = false;
      console.log("👂 Initial ENV snapshot received (skipped - no update/restart).");
      return;
    }

    console.log("\n🔔 Firebase ENV data changed");

    try {
      // Chạy file mjs và lấy kết quả qua stdout
      console.log(`⚡⚡ node ./js-scripts/load-env-from-url.mjs`);
      const stdout = execSync(`node ./js-scripts/load-env-from-url.mjs`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
      });
      console.log(`⚡⚡ stdout: ${stdout}`);

      console.log("\n♻️  ENV updated -> restarting PM2 apps (sequential)...");
      try {
        await restartPM2Apps(pm2Apps);
      } catch (e) {
        console.error("❌ Restart sequence error:", e.message);
      }
    } catch (error) {
      console.error("❌ Error running load-env-from-url.mjs:", error.message);
    }
  };

  envRef.on(
    "value",
    (snap) => Promise.resolve(onEnvValue(snap)).catch((e) => console.error("❌ Handler error:", e.message)),
    (error) => console.error("❌ Firebase ENV listener error:", error.message)
  );

  function stop() {
    try {
      envRef.off();
      activeIdRef.off();
      console.log("🛑 Listener stopped.");
    } catch {}
  }

  async function shutdown() {
    console.log("\n👋 Shutting down...");
    stop();
    try {
      await instanceRef.update({
        stoppedAt: admin.database.ServerValue.TIMESTAMP,
        status: "stopped",
      });
    } catch {}
    try {
      await admin.app(projectId).delete();
    } catch (e) {
      console.error("⚠️  Shutdown warning:", e.message);
    }
  }

  return {
    admin,
    app,
    projectId,
    instanceId,
    firebasePath,
    runtimeBase,
    activeIdPath,
    envFilePath,
    pm2Apps,
    stop,
    shutdown,
  };
}

// ====== Run directly ======
async function main() {
  const keyFromArgv = process.argv[2];
  const serviceAccountB64EnvKey = keyFromArgv || "ENV_LISTENER_FB_SERVICES_ACCOUNT_BASE64";

  const runner = startEnvListener(serviceAccountB64EnvKey);

  process.on("SIGINT", async () => {
    await runner.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await runner.shutdown();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("❌ Fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { startEnvListener };
