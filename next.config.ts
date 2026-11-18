import path from "node:path";
import type { NextConfig } from "next";

// Next.js infers its workspace root by walking up the tree looking for
// lockfiles. When that resolves to a drive root it can start crawling unrelated
// or protected system directories (for example "E:\System Volume Information"),
// which produces Watchpack EINVAL errors. Pin every bundler/tracing root to the
// directory that actually contains this config file.
const projectRoot = path.resolve(__dirname);

// Watchpack's initial scan lists and lstat()s every entry of a watched
// directory BEFORE applying its ignore filter, so a directory watcher on a
// drive root (for example "E:\") crashes on protected entries such as
// "E:\System Volume Information" (EINVAL). Webpack creates such a watcher while
// resolving modules because enhanced-resolve probes drive-root candidates like
// "E:\package.json" and "E:\node_modules".
//
// This filter ignores:
//   - node_modules/.git/.next anywhere in a path (Next's default behaviour),
//   - Windows system folders,
//   - any single-segment entry directly under a drive root (E:\package.json,
//     E:\node_modules, ...) so no watcher is ever created on "E:\" itself.
// Watchpack normalises backslashes to forward slashes before matching.
const ignoredWatchPattern =
  /(?:^|[/\\])(?:node_modules|\.git|\.next|System Volume Information|\$Recycle\.Bin|Config\.Msi|Recovery)(?:[/\\]|$)|^[a-zA-Z]:[/\\]?$|^[a-zA-Z]:[/\\][^/\\]+$/;

if (process.env.NODE_ENV === "production") {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 32) {
    throw new Error("Production error: AUTH_SECRET must be configured and at least 32 characters.");
  }
  const adminPassword = process.env.ADMIN_PASSWORD;
  const weakPasswords = ["admin", "password", "12345678", "AdminPass2026!Secure", "Admin123!", "ChangeMe123!"];
  if (adminPassword && weakPasswords.includes(adminPassword)) {
    throw new Error("Production error: ADMIN_PASSWORD cannot use default/weak values in production.");
  }
  if (process.env.DISABLE_AUTH_RATE_LIMIT && process.env.DISABLE_AUTH_RATE_LIMIT !== "0" && process.env.DISABLE_AUTH_RATE_LIMIT !== "false") {
    throw new Error("Production error: DISABLE_AUTH_RATE_LIMIT cannot be enabled in production.");
  }
  if (process.env.COOKIE_SECURE === "false" || process.env.COOKIE_SECURE === "0") {
    throw new Error("Production error: COOKIE_SECURE cannot be false in production (HTTPS required).");
  }
}

const nextConfig: NextConfig = {
  experimental: { cpus: 2 }, // cap build workers; shared hosting can't spawn 63
  // Allow the test runner to use an isolated build/dev directory so it never
  // collides with (or reuses) a developer's running `next dev` server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  env: {
    NEXT_PUBLIC_MAX_LEAD_LIMIT: process.env.MAX_LEAD_LIMIT ?? "100",
    NEXT_PUBLIC_MAX_PROFILE_BATCH: process.env.MAX_PROFILE_BATCH_SIZE ?? "1000",
    MAX_LEAD_LIMIT: process.env.MAX_LEAD_LIMIT ?? "100",
    MAX_PROFILE_BATCH_SIZE: process.env.MAX_PROFILE_BATCH_SIZE ?? "1000",
  },
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Constrain Webpack/Watchpack to the project directory and explicitly
      // ignore drive-root system folders.
      config.context = projectRoot;
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ignoredWatchPattern,
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
