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
// 🧩 HELPER LOG
// ========================================
function shortKey(key) {
  if (!key) return "unknown";
  let k = String(key);

  // rút gọn kiểu: images-worker-tlt29-workers-dev -> tlt29
  k = k.replace(/^images-worker-/, "");
  k = k.replace(/-workers-(dev|prod)$/i, "");
  k = k.replace(/-workers$/i, "");
  k = k.replace(/-dev$/i, "");

  // nếu vẫn dài quá thì cắt bớt
  if (k.length > 28) k = k.slice(0, 12) + "…" + k.slice(-10);

  return k;
}

function joinKeys(keys, limit = 18) {
  const arr = (keys || []).map(shortKey);
  if (arr.length <= limit) return arr.join(", ");
  const head = arr.slice(0, limit).join(", ");
  return `${head}, …(+${arr.length - limit})`;
}
function buildOrderLine(sortedKeys, nextIndex) {
  const keys = sortedKeys || [];
  if (keys.length === 0) return "∅";

  const ordered = keys.map(shortKey);
  const chainLimit = 20;
  const lineLimit = 7; // Số lượng key tối đa trên một dòng

  let chain = ordered;
  let more = 0;
  if (ordered.length > chainLimit) {
    chain = ordered.slice(0, chainLimit);
    more = ordered.length - chainLimit;
  }

  // Chia chuỗi thành nhiều dòng nếu cần
  const chunks = [];
  while (chain.length > lineLimit) {
    chunks.push(chain.slice(0, lineLimit).join(" → "));
    chain = chain.slice(lineLimit);
  }
  chunks.push(chain.join(" → ")); // Thêm phần còn lại vào dòng cuối

  const nextKey = keys[nextIndex % keys.length];
  const nextShort = shortKey(nextKey);

  // Nếu có nhiều hơn 1 dòng, xuống dòng giữa các đoạn
  const orderLine = chunks.join("\n");

  return `${orderLine}${more > 0 ? ` → …(+${more})` : ""}   |   ⏭️ next: ${nextShort}`;
}

function buildOrderLine_remove(sortedKeys, nextIndex) {
  const keys = sortedKeys || [];
  if (keys.length === 0) return "∅";

  const ordered = keys.map(shortKey);
  const chainLimit = 20;

  let chain = ordered;
  let more = 0;
  if (ordered.length > chainLimit) {
    chain = ordered.slice(0, chainLimit);
    more = ordered.length - chainLimit;
  }

  const nextKey = keys[nextIndex % keys.length];
  const nextShort = shortKey(nextKey);

  return `${chain.join(" → ")}${more > 0 ? ` → …(+${more})` : ""}   |   ⏭️ next: ${nextShort}`;
}

// ========================================
// 🎯 QUẢN LÝ DANH SÁCH WORKER
// ========================================
class WorkerPool {
  constructor() {
    this.workers = new Map(); // key -> worker info
    this.sortedKeys = []; // key list sorted by upload_at
    this.currentIndex = 0;

    this._firstSyncLogged = false;
  }

  _toComparable(data) {
    if (!data) return null;
    return {
      url: data.url || "",
      upload_at: normalizeUploadAt(data.upload_at),
      version: data.version || "unknown",
      runner_by: data.runner_by || "unknown",
    };
  }

  _snapshotComparableMap() {
    const m = new Map();
    for (const [key, w] of this.workers.entries()) {
      m.set(key, {
        url: w.url || "",
        upload_at: w.upload_at || 0,
        version: w.version || "unknown",
        runner_by: w.runner_by || "unknown",
      });
    }
    return m;
  }

  updateWorker(key, data, resort = true, log = false) {
    if (!data || !data.url) {
      if (log) console.warn(`⚠️  Worker ${key} không có URL, bỏ qua`);
      return false;
    }

    const uploadAt = normalizeUploadAt(data.upload_at);

    const prev = this.workers.get(key);
    const next = {
      key,
      url: data.url,
      upload_at: uploadAt,
      version: data.version || "unknown",
      runner_by: data.runner_by || "unknown",
    };

    this.workers.set(key, next);

    if (resort) this._resort();

    // trả về "có thay đổi gì không" để syncFromObject tự log gọn
    if (!prev) return true;

    return prev.url !== next.url || prev.upload_at !== next.upload_at || prev.version !== next.version || prev.runner_by !== next.runner_by;
  }

  removeWorker(key, resort = true, log = false) {
    if (this.workers.has(key)) {
      this.workers.delete(key);
      if (resort) this._resort();
      if (log) console.log(`🗑️  Đã xóa worker: ${key}`);
      return true;
    }
    return false;
  }

  // ✅ Đồng bộ theo "state cuối cùng" từ Firebase + log gọn theo diff
  syncFromObject(obj) {
    const before = this._snapshotComparableMap();

    const incoming = obj || {};
    const nextKeys = new Set(Object.keys(incoming));

    const removed = [];
    const added = [];
    const updated = [];

    // remove missing
    for (const key of Array.from(this.workers.keys())) {
      if (!nextKeys.has(key)) {
        const ok = this.removeWorker(key, false, false);
        if (ok) removed.push(key);
      }
    }

    // upsert all (silent)
    for (const [key, raw] of Object.entries(incoming)) {
      const nextComp = this._toComparable(raw);
      if (!nextComp || !nextComp.url) continue;

      const existed = before.has(key);
      const changed = this.updateWorker(
        key,
        { ...raw, upload_at: nextComp.upload_at, version: nextComp.version, runner_by: nextComp.runner_by },
        false,
        false
      );

      if (!existed) added.push(key);
      else if (changed) updated.push(key);
    }

    this._resort();

    const hasDiff = added.length || removed.length || updated.length;

    // log lần đầu hoặc khi có thay đổi
    if (!this._firstSyncLogged || hasDiff) {
      const total = this.size();

      if (!this._firstSyncLogged) {
        console.log(`🔄 Synced workers: ${total}`);
        console.log(`🧭 RR order: ${buildOrderLine(this.sortedKeys, this.currentIndex)}`);
        this._firstSyncLogged = true;
        return;
      }

      // log gọn phần thay đổi
      const parts = [];
      if (added.length) parts.push(`➕ ${added.length}`);
      if (removed.length) parts.push(`➖ ${removed.length}`);
      if (updated.length) parts.push(`✏️ ${updated.length}`);

      console.log(`🔁 Worker pool changed (${parts.join(" | ") || "no-diff"}), total=${total}`);

      if (added.length) console.log(`   ➕ Added: ${joinKeys(added)}`);
      if (removed.length) console.log(`   ➖ Removed: ${joinKeys(removed)}`);
      if (updated.length) console.log(`   ✏️ Updated: ${joinKeys(updated)}`);

      console.log(`   🧭 RR order: ${buildOrderLine(this.sortedKeys, this.currentIndex)}`);
    }
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
      // ✅ không log dài từng worker nữa, log gọn nằm trong syncFromObject()
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
      console.log(`✅ Đã load ${workerPool.size()} worker(s)`);
      // ✅ danh sách + thứ tự đã được log gọn trong syncFromObject() rồi
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
