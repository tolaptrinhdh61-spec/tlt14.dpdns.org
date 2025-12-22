#!/usr/bin/env node
/**
 * azure-repo-push-finish.js
 * ✅ Cross-platform (Linux/Windows)
 * ✅ Use PAT if provided, otherwise SYSTEM_ACCESSTOKEN
 * ✅ Copy configured folders into a repo workdir, commit & push to Azure Repos
 */
/**
 * ENV_AZURE_REPO_PUSH_FINISH_COPY supports:
 *  - "folderA"
 *  - "folderA=dest/path/in/repo"
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

function log(...a) {
  console.log(...a);
}
function warn(...a) {
  console.warn(...a);
}
function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function runGit(args, { cwd, extraHeader } = {}) {
  const fullArgs = [];
  if (extraHeader) {
    fullArgs.push("-c", `http.extraheader=${extraHeader}`);
  }
  fullArgs.push(...args);

  const r = spawnSync("git", fullArgs, {
    cwd,
    stdio: "inherit",
    shell: os.platform() === "win32", // safer on Windows agents
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with code ${r.status}`);
  }
}

function ensureEmptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function safeSplitList(v) {
  if (!v) return [];
  return String(v)
    .split(/\r?\n|;|,/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ENV_AZURE_REPO_PUSH_FINISH_COPY supports:
 *  - "folderA"
 *  - "folderA=dest/path/in/repo"
 */
function parseCopyRules(copyEnv) {
  const items = safeSplitList(copyEnv);
  return items.map((item) => {
    const eq = item.indexOf("=");
    if (eq > 0) {
      const src = item.slice(0, eq).trim();
      const dest = item.slice(eq + 1).trim();
      return { src, dest: dest || path.basename(src) };
    }
    return { src: item, dest: path.basename(item) };
  });
}

function copyRecursive(srcAbs, destAbs) {
  // ✅ Prefer cpSync with dereference to avoid committing symlinks
  if (fs.cpSync) {
    // Node versions differ; dereference is supported on modern Node
    // verbatimSymlinks may not exist; keep it guarded.
    const opts = { recursive: true, force: true, dereference: true };
    try {
      fs.cpSync(srcAbs, destAbs, { ...opts, verbatimSymlinks: false });
    } catch {
      fs.cpSync(srcAbs, destAbs, opts);
    }
    return;
  }

  // Fallback manual copy (also dereference)
  const lst = fs.lstatSync(srcAbs);
  if (lst.isSymbolicLink()) {
    const real = fs.realpathSync(srcAbs);
    return copyRecursive(real, destAbs);
  }
  if (lst.isDirectory()) {
    fs.mkdirSync(destAbs, { recursive: true });
    for (const name of fs.readdirSync(srcAbs)) {
      copyRecursive(path.join(srcAbs, name), path.join(destAbs, name));
    }
  } else {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
  }
}

function buildAuthHeader() {
  const pat = process.env.ENV_AZURE_REPO_PUSH_FINISH_PAT || "";
  const sys = process.env.SYSTEM_ACCESSTOKEN || "";

  if (pat) {
    // Basic auth with PAT
    const b64 = Buffer.from(`pat:${pat}`, "utf8").toString("base64");
    return { header: `AUTHORIZATION: Basic ${b64}`, mode: "PAT" };
  }
  if (sys) {
    // Bearer token (OAuth)
    return { header: `AUTHORIZATION: Bearer ${sys}`, mode: "SYSTEM_ACCESSTOKEN" };
  }
  return { header: "", mode: "" };
}

function getBranchName() {
  return process.env.ENV_AZURE_REPO_PUSH_FINISH_BRANCH || process.env.BUILD_SOURCEBRANCHNAME || "main";
}

function getCommitMessage() {
  const buildNum = process.env.BUILD_BUILDNUMBER || "";
  const buildId = process.env.BUILD_BUILDID || "";
  const now = new Date().toISOString();
  return process.env.ENV_AZURE_REPO_PUSH_FINISH_MESSAGE || `chore(pipeline): push artifacts (build=${buildNum || buildId || "n/a"}) @ ${now}`;
}

async function main() {
  const repoUrl = process.env.ENV_AZURE_REPO_PUSH_FINISH_URL || "";
  if (!repoUrl) {
    log("ℹ️ ENV_AZURE_REPO_PUSH_FINISH_URL not set => skip push.");
    return;
  }

  const { header: extraHeader, mode } = buildAuthHeader();
  if (!extraHeader) {
    fail("❌ Missing token. Provide ENV_AZURE_REPO_PUSH_FINISH_PAT or enable SYSTEM_ACCESSTOKEN.");
  }

  const branch = getBranchName();
  const workdir = path.resolve(process.env.ENV_AZURE_REPO_PUSH_FINISH_WORKDIR || ".azrepo-push");
  const rules = parseCopyRules(process.env.ENV_AZURE_REPO_PUSH_FINISH_COPY || "");

  if (rules.length === 0) {
    log("ℹ️ ENV_AZURE_REPO_PUSH_FINISH_COPY empty => nothing to push.");
    return;
  }

  const gitName = process.env.ENV_AZURE_REPO_PUSH_FINISH_GIT_NAME || "azure-pipeline";
  const gitEmail = process.env.ENV_AZURE_REPO_PUSH_FINISH_GIT_EMAIL || "azure-pipeline@local";

  log(`🔐 Auth mode: ${mode}`);
  log(`📦 Repo: ${repoUrl}`);
  log(`🌿 Branch: ${branch}`);
  log(`📁 Workdir: ${workdir}`);

  ensureEmptyDir(workdir);

  // Clone (try branch first; if not exist, clone default then create branch)
  try {
    log("⬇️ Cloning target repo (branch)...");
    runGit(["clone", "--depth", "1", "--branch", branch, repoUrl, workdir], { extraHeader });
  } catch (e) {
    warn("⚠️ Clone by branch failed, trying default branch then checkout -B ...");
    ensureEmptyDir(workdir);
    runGit(["clone", "--depth", "1", repoUrl, workdir], { extraHeader });
    runGit(["checkout", "-B", branch], { cwd: workdir });
  }

  // Configure identity
  runGit(["config", "user.name", gitName], { cwd: workdir });
  runGit(["config", "user.email", gitEmail], { cwd: workdir });

  // Copy folders
  const cwd = process.cwd();
  for (const { src, dest } of rules) {
    const srcAbs = path.resolve(cwd, src);
    const destAbs = path.resolve(workdir, dest);

    if (!fs.existsSync(srcAbs)) {
      warn(`⚠️ Skip (not found): ${src}`);
      continue;
    }

    log(`📥 Copy: ${src}  =>  ${dest}`);
    fs.rmSync(destAbs, { recursive: true, force: true });
    copyRecursive(srcAbs, destAbs);
  }

  // Commit if changed
  runGit(["add", "-A"], { cwd: workdir });

  const st = spawnSync("git", ["status", "--porcelain"], {
    cwd: workdir,
    encoding: "utf8",
    shell: os.platform() === "win32",
  });
  const changed = (st.stdout || "").trim();

  if (!changed) {
    log("✅ No changes to commit => skip push.");
    return;
  }

  const msg = getCommitMessage();
  log(`📝 Commit: ${msg}`);
  runGit(["commit", "-m", msg], { cwd: workdir });

  log("🚀 Pushing...");
  runGit(["push", "origin", `HEAD:${branch}`], { cwd: workdir, extraHeader });

  log("✅ Push done.");
}

main().catch((e) => {
  console.error("❌ Push failed:", e && e.message ? e.message : e);
  process.exit(1);
});
