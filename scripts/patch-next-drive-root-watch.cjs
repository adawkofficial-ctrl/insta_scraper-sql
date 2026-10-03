#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/*
 * Next.js fix: drive-root Watchpack EINVAL on Windows.
 *
 * In development, Next.js watches the project directory as a "missing" path in
 * `server/lib/start-server.js`:
 *
 *     const Watchpack = require("next/dist/compiled/watchpack");
 *     const wp = new Watchpack();
 *     wp.watch({ files: configFiles, missing: dirWatchPaths });
 *
 * Watchpack turns a watched path into a directory watcher on its `dirname`. When
 * the project lives directly under a filesystem root (for example
 * `E:\insta_scraper`), `dirname(projectDir)` is the drive root `E:\`. Its
 * initial scan `lstat()`s every root entry, including the protected
 * `E:\System Volume Information`, which throws and is logged as:
 *
 *     Watchpack Error (initial scan): Error: EINVAL: invalid argument,
 *     lstat 'E:\System Volume Information'
 *
 * There is no Next.js config option for this watcher, so this script applies a
 * minimal, idempotent patch: pass an `ignored` predicate that skips the project
 * directory itself. Config-file watching and distDir deletion watching are
 * unaffected (they use other paths).
 *
 * Runs from `postinstall` and `predev` so it survives reinstalls and is always
 * present before `next dev` starts. It never fails an install.
 */
const fs = require("node:fs");
const path = require("node:path");

const NEEDLE = "const wp = new Watchpack();";
const REPLACEMENT =
  "const wp = new Watchpack({ ignored: (pathname) => pathname === dir });";

function nextPackageDir() {
  try {
    return path.dirname(require.resolve("next/package.json"));
  } catch {
    const fallback = path.join(process.cwd(), "node_modules", "next");
    return fs.existsSync(path.join(fallback, "package.json")) ? fallback : null;
  }
}

const nextDir = nextPackageDir();
if (!nextDir) {
  console.warn(
    "[patch-next-drive-root-watch] Next.js not found; skipping (nothing to patch).",
  );
  process.exit(0);
}

const targets = [
  path.join(nextDir, "dist", "server", "lib", "start-server.js"),
  path.join(nextDir, "dist", "esm", "server", "lib", "start-server.js"),
];

let alreadyPatched = 0;
let patchedNow = 0;
let missing = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) {
    missing += 1;
    continue;
  }

  const source = fs.readFileSync(file, "utf8");

  if (source.includes(REPLACEMENT)) {
    alreadyPatched += 1;
    continue;
  }

  if (!source.includes(NEEDLE)) {
    missing += 1;
    continue;
  }

  fs.writeFileSync(file, source.split(NEEDLE).join(REPLACEMENT));
  patchedNow += 1;
}

if (patchedNow > 0) {
  console.log(
    `[patch-next-drive-root-watch] Patched ${patchedNow} Next.js file(s) to disable the drive-root watcher.`,
  );
} else if (alreadyPatched > 0) {
  // Already patched: stay quiet so dev/install output is clean.
} else if (missing > 0) {
  console.warn(
    "[patch-next-drive-root-watch] Expected Next.js watcher code was not found; skipped (version may have changed).",
  );
}
