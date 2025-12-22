#!/usr/bin/env node
/**
 * js-scripts/load-env-from-url.mjs
 * Load JSON from URL and export to:
 * - GitHub Actions: via GITHUB_ENV (persist across steps in same job)
 * - Azure Pipelines: via ##vso[task.setvariable] (persist across subsequent tasks)
 *
 * Extra features:
 * - If a key ends with __BASE64__, also create a decoded variable:
 *     NGINX_CONF__BASE64__ => also export NGINX_CONF = base64Decode(value)
 * - If value is object/array, store as JSON string
 *
 * Security/logging:
 * - GitHub Actions: auto-mask ALL exported values via ::add-mask::
 * - Azure Pipelines: set variables with issecret=true (masked in logs)
 * - DEV mode: prints keys only (values masked)
 */

import fs from "node:fs";
import process from "node:process";

const BASE64_SUFFIX = "__BASE64__";

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

  // GitHub: mask whole string
  const normalized = s.replace(/\r/g, "");
  process.stdout.write(`::add-mask::${normalized}\n`);

  // If multiline, also mask each line (helps prevent partial leaks)
  if (normalized.includes("\n")) {
    for (const line of normalized.split("\n")) {
      if (line) process.stdout.write(`::add-mask::${line}\n`);
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

/** Export variable into: current process + GitHub env file + Azure variables */
function exportVarEverywhere({ key, value, inGitHub, githubEnvFile, inAzure }) {
  // current process env
  process.env[key] = value;

  // ✅ Mask value in CI logs (best-effort)
  if (inGitHub) {
    addMaskGitHub(value);
  }

  // GitHub persists for next steps
  if (inGitHub && githubEnvFile) {
    appendGitHubEnv(githubEnvFile, key, value);
  }

  // Azure persists for next tasks (marked secret to mask logs)
  if (inAzure) {
    const safe = String(value).replace(/\r?\n/g, "\\n");
    process.stdout.write(`##vso[task.setvariable variable=${key};issecret=true]${safe}\n`);
  }
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
  const dev = isDevStage();

  const exported = [];
  const warnings = [];

  for (const [rawKey, rawVal] of Object.entries(json)) {
    const { key, changed, original } = normalizeKey(rawKey);
    const value = toEnvValue(rawVal);

    if (changed) warnings.push(`Key "${original}" sanitized -> "${key}"`);

    // ✅ Export original key/value
    try {
      exportVarEverywhere({ key, value, inGitHub, githubEnvFile, inAzure });
    } catch (e) {
      console.error(`❌ Export failed for "${key}":`, e?.message || e);
      process.exit(4);
    }
    exported.push(key);

    // ✅ If ends with __BASE64__, also export decoded version
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

      try {
        exportVarEverywhere({ key: baseKey, value: decoded, inGitHub, githubEnvFile, inAzure });
      } catch (e) {
        console.error(`❌ Export failed for decoded "${baseKey}":`, e?.message || e);
        process.exit(4);
      }
      exported.push(baseKey);
    }
  }

  for (const w of warnings) console.error(`⚠️ ${w}`);

  const where = (inGitHub ? "GitHub" : "") + (inGitHub && inAzure ? "+" : "") + (inAzure ? "Azure" : "") + (!inGitHub && !inAzure ? "Local" : "");

  console.log(`✅ ENV_STAGE=${process.env.ENV_STAGE || "PROD"} | Loaded ${exported.length} env var(s) into: ${where}`);

  if (dev) {
    console.log("🧪 DEV mode: exported keys (values are masked)");
    for (const k of exported) console.log(`${k}=***`);
  }
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
