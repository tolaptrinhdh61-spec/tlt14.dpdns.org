// pm2Restart.js
// Nghiệp vụ: Restart PM2 apps (tuần tự: app1 xong mới tới app2)

const pm2 = require("pm2");

function restartOne(appName) {
  return new Promise((resolve, reject) => {
    pm2.restart({ name: appName, updateEnv: true }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function restartPM2Apps(pm2Apps) {
  const apps = Array.isArray(pm2Apps) ? pm2Apps.map((x) => (x || "").trim()).filter(Boolean) : [];

  if (apps.length === 0) {
    console.log("⚠️  No PM2 apps configured");
    return { ok: true, restarted: [], failed: [] };
  }

  // connect 1 lần, restart tuần tự, rồi disconnect
  await new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  }).catch((err) => {
    console.error("❌ PM2 connect error:", err.message);
    throw err;
  });

  const restarted = [];
  const failed = [];

  try {
    for (const name of apps) {
      try {
        console.log(`⏳ Restarting: ${name} ...`);
        await restartOne(name);
        console.log(`✅ Restarted: ${name}`);
        restarted.push(name);
      } catch (err) {
        console.error(`❌ Failed to restart ${name}:`, err.message);
        failed.push({ name, error: err.message });
        // vẫn tiếp tục app tiếp theo (tuần tự nhưng không dừng toàn bộ)
      }
    }
  } finally {
    try {
      pm2.disconnect();
    } catch {}
  }

  return {
    ok: failed.length === 0,
    restarted,
    failed,
  };
}

module.exports = { restartPM2Apps };
