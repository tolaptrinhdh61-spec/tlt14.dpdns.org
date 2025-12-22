#!/usr/bin/env node
/**
 * List files/folders under current working directory (PWD),
 * excluding common noisy directories like .git, node_modules, etc.
 *
 * Usage:
 *   node scripts/list-files.mjs
 *   node scripts/list-files.mjs --maxDepth=6
 *   node scripts/list-files.mjs --onlyFiles
 */

import fs from "node:fs";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split("=");
    return [k, v ?? "true"];
  })
);

const MAX_DEPTH = Number(args.get("--maxDepth") ?? 4);
const ONLY_FILES = String(args.get("--onlyFiles") ?? "false").toLowerCase() === "true";

// Thư mục/tệp bỏ qua (bạn có thể thêm)
const EXCLUDE_NAMES = new Set([
  ".git",
  "node_modules",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  ".DS_Store",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".artifacts",
  ".terraform",
  ".venv",
  "venv",
  "__pycache__",
]);

const EXCLUDE_PREFIXES = [".tmp"];

function shouldExclude(name) {
  if (EXCLUDE_NAMES.has(name)) return true;
  for (const p of EXCLUDE_PREFIXES) if (name.startsWith(p)) return true;
  return false;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: e };
  }
}

function walk(dir, depth, prefix, isLast) {
  const base = path.basename(dir);
  if (depth === 0) {
    console.log(`${base}/`);
  }

  if (depth >= MAX_DEPTH) return;

  const entriesOrErr = safeReaddir(dir);
  if (entriesOrErr.error) {
    console.log(`${prefix}${isLast ? "└─" : "├─"} ⚠️ [no access]`);
    return;
  }

  /** @type {fs.Dirent[]} */
  let entries = entriesOrErr
    .filter((e) => !shouldExclude(e.name))
    .sort((a, b) => {
      // folders first, then files; alpha
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  if (ONLY_FILES) {
    entries = entries.filter((e) => !e.isDirectory());
  }

  entries.forEach((ent, idx) => {
    const last = idx === entries.length - 1;
    const branch = last ? "└─" : "├─";
    const nextPrefix = prefix + (last ? "  " : "│ ");

    if (ent.isDirectory()) {
      console.log(`${prefix}${branch} ${ent.name}/`);
      walk(path.join(dir, ent.name), depth + 1, nextPrefix, last);
    } else if (ent.isSymbolicLink()) {
      console.log(`${prefix}${branch} ${ent.name} @`);
    } else {
      let size = "";
      try {
        const st = fs.statSync(path.join(dir, ent.name));
        size = ` (${st.size}b)`;
      } catch {}
      console.log(`${prefix}${branch} ${ent.name}${size}`);
    }
  });
}

const root = process.cwd();
walk(root, 0, "", true);
