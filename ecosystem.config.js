const path = require("path");
const fs = require("fs");

const CWD = process.env.APP_CWD || process.cwd();
const ENV_FILE = process.env.ENV_FILE || path.join(CWD, ".env.runtime");

module.exports = {
  apps: [
    {
      name: "nginx",
      script: path.join(CWD, "run-nginx.mjs"),
      interpreter: "node",
      cwd: CWD,
      autorestart: true,
      max_restarts: 10,
      // ✅ PM2 nạp env từ file (mỗi lần start/restart)
      env_file: ENV_FILE,
      env: {
        APP_CWD: CWD,
        NGINX_CONF_PATH: path.join(CWD, "nginx.conf"),
        NGINX_PREFIX: path.join(CWD, "nginx"),
        TZ: "Asia/Ho_Chi_Minh",
        // ✅ QUAN TRỌNG: Phải truyền config vào đây
        NGINX_CONF__BASE64__: process.env.NGINX_CONF__BASE64__ || "",
        NGINX_CONF: process.env.NGINX_CONF || "",
        TZ: "Asia/Ho_Chi_Minh",
      },
    },
    {
      name: "cloudflared",
      script: "cloudflared",
      interpreter: "none",
      cwd: CWD,
      args: `tunnel --loglevel debug --no-autoupdate run --token ${process.env.CLOUDFLARE_TUNNEL_TOKEN || ""}`,
      autorestart: true,
      max_restarts: 10,
      // ✅ PM2 nạp env từ file (mỗi lần start/restart)
      env_file: ENV_FILE,
      env: {
        TZ: "Asia/Ho_Chi_Minh",
      },
    },
    {
      name: "envListener",
      script: path.join(CWD, "envListener.js"),
      interpreter: "node",
      cwd: CWD,
      autorestart: true,
      max_restarts: 10,
      // ✅ PM2 nạp env từ file (mỗi lần start/restart)
      env_file: ENV_FILE,
      env: {
        APP_CWD: CWD,
        TZ: "Asia/Ho_Chi_Minh",
      },
    },
  ],
};
