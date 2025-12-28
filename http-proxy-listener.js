#!/usr/bin/env node
// http-proxy-listener.js
// 🔁 HTTP Proxy với load balancing từ Firebase Realtime Database (SYNC by on("value"))

const http = require("http");
const httpProxy = require("http-proxy");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

// ========================================
// 📋 CẤU HÌNH
// ========================================
const PORT = process.env.ENV_HTTP_PROXY_PORT || 8080;
const FB_ACCOUNT_BASE64 = process.env.ENV_LISTENER_FB_SERVICES_ACCOUNT_BASE64;

// ========================================
// 🔥 FIREBASE SETUP
// ========================================
let db = null;
let workersRef = null;

function initFirebase() {
  if (!FB_ACCOUNT_BASE64) {
    throw new Error("❌ Thiếu ENV_LISTENER_FB_SERVICES_ACCOUNT_BASE64");
  }

  try {
    const serviceAccount = JSON.parse(Buffer.from(FB_ACCOUNT_BASE64, "base64").toString("utf8"));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app`,
    });

    db = admin.database();
    workersRef = db.ref("worker-stats");
    console.log("✅ Firebase đã kết nối");
  } catch (err) {
    console.error("❌ Lỗi khi khởi tạo Firebase:", err.message);
    throw err;
  }
}

// ========================================
// 🧼 NORMALIZE upload_at
// ========================================
function normalizeUploadAt(v) {
  // number timestamp
  if (typeof v === "number" && Number.isFinite(v)) return v;

  // ISO string
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  }

  // placeholder kiểu { ".sv": "timestamp" }
  if (v && typeof v === "object" && v[".sv"] === "timestamp") {
    // tạm dùng Date.now(); khi server resolve sẽ sync lại value thật
    return Date.now();
  }

  return Date.now();
}

// ========================================
// 🎯 QUẢN LÝ DANH SÁCH WORKER
// ========================================
class WorkerPool {
  constructor() {
    this.workers = new Map(); // key -> worker info
    this.sortedKeys = []; // key list sorted by upload_at
    this.currentIndex = 0;
  }

  updateWorker(key, data, resort = true) {
    if (!data || !data.url) {
      console.warn(`⚠️  Worker ${key} không có URL, bỏ qua`);
      return;
    }

    const uploadAt = normalizeUploadAt(data.upload_at);

    this.workers.set(key, {
      key,
      url: data.url,
      upload_at: uploadAt,
      version: data.version || "unknown",
      runner_by: data.runner_by || "unknown",
    });

    if (resort) this._resort();

    console.log(`✅ Cập nhật worker: ${key} → ${data.url}`);
  }

  removeWorker(key, resort = true) {
    if (this.workers.has(key)) {
      this.workers.delete(key);
      if (resort) this._resort();
      console.log(`🗑️  Đã xóa worker: ${key}`);
    }
  }

  // ✅ Đồng bộ theo "state cuối cùng" từ Firebase
  syncFromObject(obj) {
    const nextKeys = new Set(Object.keys(obj || {}));

    // remove missing
    for (const key of Array.from(this.workers.keys())) {
      if (!nextKeys.has(key)) this.removeWorker(key, false);
    }

    // upsert all
    for (const [key, data] of Object.entries(obj || {})) {
      this.updateWorker(key, data, false);
    }

    this._resort();
  }

  _resort() {
    // giữ “điểm đang đứng” nếu có thể, để round-robin không nhảy quá gắt
    const currentKey = this.sortedKeys[this.currentIndex];

    this.sortedKeys = Array.from(this.workers.values())
      .sort((a, b) => a.upload_at - b.upload_at)
      .map((w) => w.key);

    if (this.sortedKeys.length === 0) {
      this.currentIndex = 0;
      return;
    }

    if (currentKey) {
      const idx = this.sortedKeys.indexOf(currentKey);
      this.currentIndex = idx >= 0 ? idx : 0;
    } else if (this.currentIndex >= this.sortedKeys.length) {
      this.currentIndex = 0;
    }
  }

  getNextWorker() {
    if (this.sortedKeys.length === 0) return null;

    const key = this.sortedKeys[this.currentIndex];
    const worker = this.workers.get(key);

    this.currentIndex = (this.currentIndex + 1) % this.sortedKeys.length;

    return worker || null;
  }

  getAllWorkers() {
    return Array.from(this.workers.values()).sort((a, b) => a.upload_at - b.upload_at);
  }

  size() {
    return this.workers.size;
  }
}

const workerPool = new WorkerPool();

// ========================================
// 🔊 LẮNG NGHE FIREBASE REALTIME (SYNC)
// ========================================
function startFirebaseListener() {
  console.log("👂 Bắt đầu sync worker-stats từ Firebase (on value)...");

  // ✅ 1 phát ăn ngay: có snapshot ban đầu + mọi thay đổi sau này đều đi qua đây
  workersRef.on(
    "value",
    (snapshot) => {
      const all = snapshot.val() || {};
      workerPool.syncFromObject(all);
      console.log(`🔄 Synced workers: ${workerPool.size()}`);
    },
    (err) => {
      console.error("❌ Lỗi on(value):", err.message);
    }
  );
}

// ========================================
// 🌐 HTTP PROXY
// ========================================
const proxy = httpProxy.createProxyServer({
  xfwd: true, // Tự động thêm X-Forwarded-* headers
  preserveHeaderKeyCase: true, // Giữ nguyên case của header
  ws: true, // Hỗ trợ WebSocket
  changeOrigin: true, // Thay đổi origin header
  followRedirects: false, // Không tự động follow redirect
});

// Xử lý lỗi proxy
proxy.on("error", (err, req, res) => {
  const reqId = (req && req.headers && req.headers["x-request-id"]) || "unknown";
  console.error(`❌ Proxy error [${reqId}]:`, err.message);

  // res có thể không tồn tại trong một số trường hợp (upgrade socket)
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Bad Gateway",
        message: "Worker không phản hồi",
        request_id: reqId,
      })
    );
  }
});

// ========================================
// 🖥️  HTTP SERVER
// ========================================
const server = http.createServer((req, res) => {
  // ✅ Health check xử lý trước, không đi proxy
  if (req.url === "/health" || req.url === "/health/" || req.url === "/nginx-health" || req.url === "/nginx-health/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          status: "ok",
          workers: workerPool.getAllWorkers().map((w) => ({
            key: w.key,
            url: w.url,
            version: w.version,
            upload_at: new Date(w.upload_at).toISOString(),
          })),
          total_workers: workerPool.size(),
        },
        null,
        2
      )
    );
    return;
  }

  // Tạo Request ID nếu chưa có
  if (!req.headers["x-request-id"]) {
    req.headers["x-request-id"] = uuidv4();
  }

  const reqId = req.headers["x-request-id"];
  const startTime = Date.now();

  // Lấy worker tiếp theo (round-robin)
  const worker = workerPool.getNextWorker();

  if (!worker) {
    console.warn(`⚠️  [${reqId}] Không có worker khả dụng`);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Service Unavailable",
        message: "Không có worker nào đang hoạt động",
        request_id: reqId,
      })
    );
    return;
  }

  // Log request
  console.log(`📨 [${reqId}] ${req.method} ${req.url} → ${worker.url}`);

  // Thêm thông tin worker vào header (optional)
  req.headers["x-proxy-worker"] = worker.key;
  req.headers["x-proxy-worker-version"] = worker.version;

  // Proxy request đến worker
  proxy.web(
    req,
    res,
    {
      target: worker.url,
    },
    (err) => {
      console.error(`❌ [${reqId}] Lỗi khi proxy đến ${worker.url}:`, err.message);
    }
  );

  // Log khi hoàn thành
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    console.log(`✅ [${reqId}] ${res.statusCode} - ${duration}ms`);
  });
});

// Xử lý WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  const reqId = req.headers["x-request-id"] || uuidv4();
  req.headers["x-request-id"] = reqId;

  const worker = workerPool.getNextWorker();

  if (!worker) {
    console.warn(`⚠️  [${reqId}] WebSocket: Không có worker khả dụng`);
    socket.destroy();
    return;
  }

  console.log(`🔌 [${reqId}] WebSocket → ${worker.url}`);

  // Optional headers để worker biết
  req.headers["x-proxy-worker"] = worker.key;
  req.headers["x-proxy-worker-version"] = worker.version;

  proxy.ws(req, socket, head, {
    target: worker.url,
  });
});

// ========================================
// 🚀 KHỞI ĐỘNG
// ========================================
async function start() {
  try {
    initFirebase();
    startFirebaseListener();

    // Không cần delay 2s nữa vì on(value) sẽ sync ngay khi có snapshot đầu tiên
    // Nhưng nếu bạn muốn chờ snapshot về để log đẹp, có thể keep 200-500ms
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (workerPool.size() === 0) {
      console.warn("⚠️  Chưa có worker nào, proxy sẽ trả về 503 cho đến khi có worker");
    } else {
      console.log(`✅ Đã load ${workerPool.size()} worker(s):`);
      workerPool.getAllWorkers().forEach((w, i) => {
        console.log(`   ${i + 1}. ${w.key} → ${w.url} (v${w.version})`);
      });
    }

    server.listen(PORT, () => {
      console.log(`\n🚀 HTTP Proxy Listener đang chạy tại http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error("❌ Lỗi khi khởi động:", err);
    process.exit(1);
  }
}

// ========================================
// 🧯 GRACEFUL SHUTDOWN
// ========================================
function shutdown() {
  console.log("\n👋 Đang tắt proxy...");

  try {
    if (workersRef) {
      // gỡ listener để tránh treo process
      workersRef.off();
    }
  } catch (_) {}

  server.close(() => {
    console.log("✅ Đã đóng server");
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Bắt đầu
start();
