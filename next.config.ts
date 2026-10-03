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

const nextConfig: NextConfig = {
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
