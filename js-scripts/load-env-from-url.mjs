#!/usr/bin/env node
/**
 * js-scripts/load-env-from-url.mjs
 * Load JSON from URL and export to:
 * - GitHub Actions: via GITHUB_ENV (persist across steps in same job)
 * - Azure Pipelines: via ##vso[task.setvariable] (persist across subsequent tasks)
 * - Local Shell: via stdout export commands (use with eval)
 *
 * Extra features:
 * - If a key ends with __BASE64-remove__, also create a decoded variable:
 *     NGINX_CONF__BASE64-remove__ => also export NGINX_CONF = base64Decode(value)
 * - If value is object/array, store as JSON string
 *
 * Security/logging:
 * - Mask ONLY selected keys (configurable below)
 * - GitHub Actions: ::add-mask::
 * - Local: secrets are still exported but marked with comment
 * - DEV mode: prints keys only (values masked)
 *
 * NEW (always-on):
 * - Always write a dotenv file ".env.runtime" in CWD (atomic write):
 *     CWD = process.env.APP_CWD || process.cwd()
 *     Output: `${CWD}/.env.runtime`
 *
 * Usage:
 *   CI/CD: node load-env-from-url.mjs
 *   Local: eval $(node load-env-from-url.mjs)
 */

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import dotenv from "dotenv";
const initEnv = (() => {
  let envPath = path.join(process.cwd(), ".env.runtime");
  if (fs.existsSync(envPath) === true) {
    dotenv.config({ path: envPath, override: true });
  } else {
    console.warn(`FILE ENV NOT FOUND: ${envPath}`);
  }
})();

const BASE64_SUFFIX = "__BASE64-remove__";

/**
 * ✅ Keys to mask (ONLY these keys will be masked)
 */
const MASK_KEYS = new Set([
  "ENV_JSON_URL",
  "CLOUDFLARE_TUNNEL_TOKEN",
  "ENV_LISTENER_FB_SERVICES_ACCOUNT_BASE64",
  "ENV_SSH_URLS",
  "PIPELINE_SSH_PUBKEY",
  "NGINX_CONF__BASE64__",
  // add more...
]);

/**
 * Optional: also mask keys by pattern (prefix/suffix)
 */
const MASK_PREFIXES = ["SECRET_", "TOKEN_", "KEY_", "PASS_"];
const MASK_SUFFIXES = ["_TOKEN", "_SECRET", "_PASSWORD", "_PASS", "_KEY"];

function shouldMaskKey(key) {
  if (MASK_KEYS.has(key)) return true;
  for (const p of MASK_PREFIXES) if (p && key.startsWith(p)) return true;
  for (const s of MASK_SUFFIXES) if (s && key.endsWith(s)) return true;
  return false;
}

/** Detect CI */
function isLikelyAzure() {
  const v = (process.env.TF_BUILD || "").toLowerCase();
  return v === "true" || v === "1";
}
function isLikelyGitHub() {
  return Boolean(process.env.GITHUB_ENV);
}

/** GitHub Actions masking (best-effort) */
function addMaskGitHub(value) {
  const s = String(value ?? "");
  if (!s) return;

  const normalized = s.replace(/\r/g, "");
  process.stderr.write(`::add-mask::${normalized}\n`);

  if (normalized.includes("\n")) {
    for (const line of normalized.split("\n")) {
      if (line) process.stderr.write(`::add-mask::${line}\n`);
    }
  }
}

/** Key normalization to safe env var name */
function normalizeKey(key) {
  const s = String(key);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { key: s, changed: false };

  const sanitized = s
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "_")
    .replace(/_+/g, "_");

  const finalKey = sanitized.length ? sanitized : "ENV_KEY";
  return { key: finalKey, changed: true, original: s };
}

/** Convert JSON values to env string */
function toEnvValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);

  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isProbablyBase64String(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 4) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(t);
}

function decodeBase64ToUtf8(s) {
  const cleaned = String(s).replace(/\s+/g, "");
  const buf = Buffer.from(cleaned, "base64");
  return buf.toString("utf8");
}

/** Escape value for shell export (single quotes) */
function escapeShellValue(value) {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return String(value).replace(/'/g, "'\\''");
}

/** Write to GITHUB_ENV safely (supports multiline) */
function appendGitHubEnv(envFilePath, key, value) {
  const hasNewline = /\r|\n/.test(value);
  if (!hasNewline) {
    fs.appendFileSync(envFilePath, `${key}=${value}\n`, "utf8");
    return;
  }

  const delimiter = `__ENV_${key}_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  fs.appendFileSync(envFilePath, `${key}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

/** Export variable into: current process + GitHub env file + Azure variables + Shell stdout */
function exportVarEverywhere({ key, value, inGitHub, githubEnvFile, inAzure, inLocal, mask, shellExports }) {
  // current process env
  process.env[key] = value;

  // ✅ Mask for CI/CD
  if (mask) {
    if (inGitHub) addMaskGitHub(value);
  }

  // GitHub persists for next steps
  if (inGitHub && githubEnvFile) {
    appendGitHubEnv(githubEnvFile, key, value);
  }

  // Azure persists for next tasks
  if (inAzure) {
    const safe = value.replace(/\r?\n/g, "\\n");
    process.stderr.write(`##vso[task.setvariable variable=${key}]${safe}\n`);
  }

  // Local shell: collect export commands
  if (inLocal && shellExports) {
    const escapedValue = escapeShellValue(value);
    const comment = mask ? " # SECRET" : "";
    shellExports.push(`export ${key}='${escapedValue}'${comment}`);
  }
}

/** Dotenv helpers: always write CWD/.env.runtime (atomic) */
function escapeDotenvValue(v) {
  const s = String(v ?? "");
  // If contains whitespace/special chars/newline/quotes/backslash/equal => JSON-quote it.
  if (/[ \t\r\n"'\\=]/.test(s)) {
    return JSON.stringify(s); // preserves newlines as \n
  }
  return s;
}

function writeDotenvAtomic(filepath, kvMap) {
  const dir = path.dirname(filepath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;

  const keys = Object.keys(kvMap).sort();
  const lines = [];
  lines.push(`# Generated by load-env-from-url.mjs at ${new Date().toISOString()}`);

  for (const k of keys) {
    // Only write safe env keys
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`${k}=${escapeDotenvValue(kvMap[k])}`);
  }
  lines.push("");

  fs.writeFileSync(tmp, lines.join("\n"), "utf8");
  fs.renameSync(tmp, filepath); // atomic on same filesystem
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.ENV_JSON_TIMEOUT_MS || 15000);
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (typeof fetch !== "function") {
      throw new Error("Global fetch() is not available. Use Node 18+.");
    }

    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function isDevStage() {
  const s = String(process.env.ENV_STAGE || "PROD")
    .trim()
    .toUpperCase();
  return s === "DEV" || s === "DEVELOPMENT";
}

async function main() {
  const url = process.argv[2] || process.env.ENV_JSON_URL;
  if (!url) {
    console.error("❌ Missing URL. Pass as arg or set ENV_JSON_URL.");
    process.exit(2);
  }

  const json = await fetchJson(url);

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    console.error("❌ JSON must be an object (top-level key/value).");
    process.exit(3);
  }

  const githubEnvFile = process.env.GITHUB_ENV;
  const inGitHub = isLikelyGitHub();
  const inAzure = isLikelyAzure();
  const inLocal = !inGitHub && !inAzure;
  const dev = isDevStage();

  const exported = [];
  const masked = [];
  const warnings = [];
  const shellExports = []; // Collect shell export commands

  // ✅ Always write fixed dotenv file in CWD
  const CWD = process.env.APP_CWD || process.cwd();
  const DOTENV_PATH = path.join(CWD, ".env.runtime");
  const dotenvKV = {}; // collect exported values for dotenv

  for (const [rawKey, rawVal] of Object.entries(json)) {
    const { key, changed, original } = normalizeKey(rawKey);
    const value = toEnvValue(rawVal);
    const mask = shouldMaskKey(key);

    if (changed) warnings.push(`Key "${original}" sanitized -> "${key}"`);

    // ✅ Export original key/value
    try {
      exportVarEverywhere({
        key,
        value,
        inGitHub,
        githubEnvFile,
        inAzure,
        inLocal,
        mask,
        shellExports,
      });
    } catch (e) {
      console.error(`❌ Export failed for "${key}":`, e?.message || e);
      process.exit(4);
    }

    // collect for dotenv
    dotenvKV[key] = value;

    exported.push(key);
    if (mask) masked.push(key);

    // ✅ If ends with __BASE64-remove__, also export decoded version
    if (key.endsWith(BASE64_SUFFIX)) {
      const baseKey = key.slice(0, -BASE64_SUFFIX.length);

      if (!baseKey) {
        warnings.push(`Key "${key}" ends with ${BASE64_SUFFIX} but base key is empty -> skipped decoded export`);
        continue;
      }

      if (!isProbablyBase64String(value)) {
        warnings.push(`Key "${key}" marked BASE64 but value doesn't look base64 -> still trying decode`);
      }

      let decoded = "";
      try {
        decoded = decodeBase64ToUtf8(value);
      } catch (e) {
        warnings.push(`Failed to base64 decode "${key}" -> "${baseKey}": ${e?.message || e}`);
        continue;
      }

      if (decoded.length === 0 && String(value).trim().length > 0) {
        warnings.push(`Decoded "${baseKey}" is empty (input non-empty). Check base64 content.`);
      }

      const baseMask = shouldMaskKey(baseKey);

      try {
        exportVarEverywhere({
          key: baseKey,
          value: decoded,
          inGitHub,
          githubEnvFile,
          inAzure,
          inLocal,
          mask: baseMask,
          shellExports,
        });
      } catch (e) {
        console.error(`❌ Export failed for decoded "${baseKey}":`, e?.message || e);
        process.exit(4);
      }

      // collect decoded for dotenv
      dotenvKV[baseKey] = decoded;

      exported.push(baseKey);
      if (baseMask) masked.push(baseKey);
    }
  }

  // ✅ Always write .env.runtime (atomic)
  try {
    writeDotenvAtomic(DOTENV_PATH, dotenvKV);
    console.error(`🧾 Wrote dotenv => ${DOTENV_PATH} (${Object.keys(dotenvKV).length} keys)`);
  } catch (e) {
    console.error(`❌ Failed writing dotenv ${DOTENV_PATH}:`, e?.message || e);
    process.exit(5);
  }

  // Output warnings to stderr (won't interfere with eval)
  for (const w of warnings) console.error(`⚠️ ${w}`);

  const where = (inGitHub ? "GitHub" : "") + (inGitHub && inAzure ? "+" : "") + (inAzure ? "Azure" : "") + (inLocal ? "Local Shell" : "");

  console.error(`✅ ENV_STAGE=${process.env.ENV_STAGE || "PROD"} | Loaded ${exported.length} env var(s) into: ${where}`);

  if (masked.length) {
    console.error(`🔒 Masked ${masked.length} key(s): ${masked.join(", ")}`);
  }

  if (inLocal) {
    if (dev) {
      console.error("🧪 DEV mode: exported keys (values masked)");
      for (const k of exported) console.error(`${k}=***`);
    } else {
      // Output shell exports to STDOUT for eval
      for (const line of shellExports) {
        console.log(line);
      }
    }

    console.error("\n💡 Usage:");
    console.error("   eval $(node load-env-from-url.mjs)");
    console.error("   pm2 restart app --update-env");
  } else if (dev) {
    console.error("🧪 DEV mode: exported keys (values masked)");
    for (const k of exported) console.error(`${k}=***`);
  }
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
