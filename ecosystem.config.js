const path = require("path");
const fs = require("fs");
const CWD = process.env.APP_CWD || process.cwd();
const ENV_DEFAULT = {
  cwd: CWD,
  autorestart: true,
  max_restarts: 10,
  env_file: process.env.ENV_FILE || path.join(CWD, ".env.runtime"),
  env: {
    APP_CWD: CWD,
    TZ: "Asia/Ho_Chi_Minh",
  },
};

module.exports = {
  apps: [
    {
      ...ENV_DEFAULT,
      name: "http-proxy-listener",
      script: path.join(CWD, "http-proxy-listener.js"),
      interpreter: "node",
    },
    {
      ...ENV_DEFAULT,
      name: "cloudflared",
      script: "cloudflared",
      interpreter: "none",
      args: `tunnel --loglevel debug --no-autoupdate run --token ${process.env.CLOUDFLARE_TUNNEL_TOKEN || ""}`,
    },
    {
      ...ENV_DEFAULT,
      name: "envListener",
      script: path.join(CWD, "envListener.js"),
      interpreter: "node",
    },
  ],
};
