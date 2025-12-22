#!/usr/bin/env node

/** js-scripts\load-env-from-url.mjs
 * Load JSON from URL and export to:
 * - GitHub Actions: via GITHUB_ENV (persist across steps in same job)
 * - Azure Pipelines: via ##vso[task.setvariable] (persist across subsequent tasks)
 *
 * Extra features:
 * - If a key ends with __BASE64__, also create a decoded variable:
 *     NGINX_CONF__BASE64__ => also export NGINX_CONF = base64Decode(value)
 * - If value is object/array, store as JSON string
 *
 */

import fs from "node:fs";
import process from "node:process";

const BASE64_SUFFIX = "__BASE64__";

function isLikelyAzure() {
  const v = (process.env.TF_BUILD || "").toLowerCase();
  return v === "true" || v === "1";
}

function isLikelyGitHub() {
  return Boolean(process.env.GITHUB_ENV);
}

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

function toEnvValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);

  // object/array -> JSON string
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function isProbablyBase64String(s) {
  // very lightweight check (avoid rejecting valid base64 with newlines)
  // allow = and newline; require length >= 4
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 4) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(t);
}

function decodeBase64ToUtf8(s) {
  // supports base64 with newlines
  const cleaned = String(s).replace(/\s+/g, "");
  const buf = Buffer.from(cleaned, "base64");

  // optional sanity: if decoding gives empty but input not empty => might be wrong
  // still return buf.toString, caller decides warning
  return buf.toString("utf8");
}

function appendGitHubEnv(envFilePath, key, value) {
  const hasNewline = /\r|\n/.test(value);
  if (!hasNewline) {
    fs.appendFileSync(envFilePath, `${key}=${value}\n`, "utf8");
    return;
  }

  const delimiter = `__ENV_${key}_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  fs.appendFileSync(envFilePath, `${key}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function exportVarEverywhere({ key, value, inGitHub, githubEnvFile, inAzure }) {
  // current process
  process.env[key] = value;

  // GitHub persists for next steps
  if (inGitHub && githubEnvFile) {
    appendGitHubEnv(githubEnvFile, key, value);
  }

  // Azure persists for next tasks
  if (inAzure) {
    const safe = value.replace(/\r?\n/g, "\\n");
    process.stdout.write(`##vso[task.setvariable variable=${key}]${safe}\n`);
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

    // ✅ If ends with __BASE64__, also export decoded version with suffix removed
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

      // sanity warning: decoded empty but input not empty
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
    console.log("🧪 DEV mode: printing exported env values");
    for (const k of exported) {
      console.log(`${k}=${process.env[k] ?? ""}`);
    }
  }
}

main().catch((err) => {
  console.error("❌ Error:", err?.message || err);
  process.exit(1);
});
