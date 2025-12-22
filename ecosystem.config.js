const path = require("path");
const fs = require("fs");

const CWD = process.env.APP_CWD || process.cwd();

module.exports = {
  apps: [
    {
      name: "nginx",
      script: path.join(CWD, "run-nginx.mjs"),
      interpreter: "node",
      cwd: CWD,
      autorestart: true,
      max_restarts: 10,
      env: {
        APP_CWD: CWD,
        NGINX_CONF_PATH: path.join(CWD, "nginx.conf"),
        NGINX_PREFIX: path.join(CWD, "nginx"),
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
      env: {
        APP_CWD: CWD,
        TZ: "Asia/Ho_Chi_Minh",
      },
    },
  ],
};
