import "server-only";

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright";

import { logger } from "@/lib/logger";

import {
  SenderBrowserMissingError,
  SenderProfileLaunchFailedError,
  type BrowserAvailability,
  type SenderAuthProbe,
  type SenderBrowserSession,
  type SenderNavigationResult,
  type SenderSessionDiagnostics,
  type SenderSessionDriver,
  type SenderSessionMode,
} from "./sender-session-driver";

const NAV_TIMEOUT_MS = 30_000;
const MANUAL_LOGIN_NAV_TIMEOUT_MS = 60_000;
const INSTAGRAM_HOME = "https://www.instagram.com/";

const RESERVED_PATH_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "developer",
  "about",
  "legal",
  "api",
  "oauth",
  "challenge",
  "privacy",
  "terms",
]);

function sanitizeReason(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw);
  // Never surface cookies/URLs with auth tokens.
  return message.replace(/\s+/g, " ").slice(0, 300);
}

/** Fuller sanitized error for launch diagnostics (still capped, no secrets). */
function sanitizeReasonFull(raw: unknown): string {
  if (raw === null || raw === undefined) return "unknown";
  const message =
    raw instanceof Error
      ? `${raw.message}${raw.cause ? ` | cause: ${String(raw.cause)}` : ""}`
      : String(raw);
  return message.replace(/\s+/g, " ").slice(0, 2000);
}

/** Origin + path only: never log query strings or fragments (may hold tokens). */
function safeUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // e.g. about:blank before navigation.
      return url.protocol === "about:" ? "about:blank" : url.protocol.replace(":", "");
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** Safe, non-secret profile directory label (relative to cwd). */
function safeProfileLabel(profileDir: string): string {
  const relative = path.relative(process.cwd(), profileDir);
  if (!relative || relative.startsWith("..")) {
    return "<outside-project>";
  }
  return relative.split(path.sep).join("/");
}

function isChallengeUrl(url: string): boolean {
  return url.includes("/challenge/") || url.includes("/checkpoint/");
}

function isLoginUrl(url: string): boolean {
  return url.includes("/accounts/login") || url.includes("/accounts/emailsignup");
}

type EngineKey = "bundled" | "chrome" | "msedge";
type LaunchedContext = { context: BrowserContext; engine: EngineKey };

/** Marker file (inside the profile) recording which engine opened this profile. */
const ENGINE_MARKER_FILE = ".sender-engine";

function readEngineMarker(profileDir: string): EngineKey | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, ENGINE_MARKER_FILE), "utf8");
    const parsed = JSON.parse(raw) as { engine?: string };
    if (parsed.engine === "bundled" || parsed.engine === "chrome" || parsed.engine === "msedge") {
      return parsed.engine;
    }
  } catch {
    // No marker yet.
  }
  return null;
}

function writeEngineMarker(profileDir: string, engine: EngineKey): void {
  try {
    fs.writeFileSync(
      path.join(profileDir, ENGINE_MARKER_FILE),
      JSON.stringify({ engine, updatedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch {
    // Marker is best-effort; never fail a launch over it.
  }
}

/** Absolute path to Playwright's bundled Chromium, or null when not installed. */
function getBundledChromiumPath(): string | null {
  try {
    const executable = chromium.executablePath();
    if (executable && fs.existsSync(executable)) {
      return executable;
    }
  } catch {
    // executablePath() throws when the browser is not installed.
  }
  return null;
}

/** Common Chrome/Edge install locations (optional fallbacks only). */
function detectChannelBrowser(): boolean {
  const candidates: string[] =
    process.platform === "win32"
      ? [
          path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];

  return candidates.some((candidate) => candidate.length > 0 && fs.existsSync(candidate));
}

function isTransientLaunchError(error: unknown): boolean {
  const message = sanitizeReason(error).toLowerCase();
  return (
    message.includes("has been closed") ||
    message.includes("target page, context or browser") ||
    message.includes("target closed") ||
    message.includes("browser has been closed") ||
    message.includes("processsingleton") ||
    message.includes("profile") && message.includes("lock")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getPlaywrightVersion(): string | null {
  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "playwright", "package.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function profileDirExists(profileDir: string): boolean {
  try {
    return fs.existsSync(profileDir) && fs.statSync(profileDir).isDirectory();
  } catch {
    return false;
  }
}

type ProfileProcess = { pid: number; name: string };

/**
 * Only browser processes count as profile locks. This prevents the diagnostic
 * PowerShell/ps command (whose own command line contains the profile path) and
 * unrelated processes from being matched or terminated.
 */
function isBrowserProcessName(name: string): boolean {
  const base = name.toLowerCase().replace(/\.exe$/, "");
  return (
    base === "chrome" ||
    base === "chromium" ||
    base === "msedge" ||
    base === "chrome-headless-shell" ||
    base === "headless_shell" ||
    base === "chrome_proxy"
  );
}

/**
 * Lists browser processes whose command line references THIS exact profile
 * directory (i.e. `--user-data-dir=<profileDir>`). Scoped to our session path
 * and to browser executables, so the user's normal Chrome/Edge is never touched.
 */
function listProfileLockProcesses(profileDir: string): ProfileProcess[] {
  try {
    if (process.platform === "win32") {
      const needle = profileDir.replace(/'/g, "''");
      const script =
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" +
        needle +
        "') } | Select-Object ProcessId,Name | ConvertTo-Json -Compress";
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      ).trim();
      if (output.length === 0) return [];
      const parsed = JSON.parse(output) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => {
          const record = row as { ProcessId?: number; Name?: string };
          return { pid: Number(record.ProcessId ?? 0), name: String(record.Name ?? "unknown") };
        })
        .filter(
          (entry) =>
            entry.pid > 0 &&
            entry.pid !== process.pid &&
            isBrowserProcessName(entry.name),
        );
    }

    const output = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      timeout: 15000,
    });
    return output
      .split(/\r?\n/)
      .filter((line) => line.includes(profileDir))
      .map((line) => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) return null;
        const args = match[2];
        const exe = path.basename(args.split(" ")[0] ?? "process");
        return { pid: Number(match[1]), name: exe };
      })
      .filter(
        (entry): entry is ProfileProcess =>
          entry !== null &&
          entry.pid !== process.pid &&
          isBrowserProcessName(entry.name),
      );
  } catch {
    return [];
  }
}

function terminateProfileProcess(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 15000,
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Already exited.
  }
}

const CHROMIUM_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/**
 * A launch only happens when SenderSessionManager holds no live session for the
 * sender, so any process still using this profile is stale and safe to stop.
 * Returns sanitized diagnostics about what was found/cleaned.
 */
function cleanupStaleProfileLock(profileDir: string): {
  detected: ProfileProcess[];
  terminated: number[];
  lockFilesRemoved: string[];
} {
  const detected = listProfileLockProcesses(profileDir);
  const terminated: number[] = [];
  for (const process of detected) {
    terminateProfileProcess(process.pid);
    terminated.push(process.pid);
  }

  const lockFilesRemoved: string[] = [];
  if (detected.length === 0 || terminated.length > 0) {
    for (const name of CHROMIUM_LOCK_FILES) {
      const lockPath = path.join(profileDir, name);
      if (fs.existsSync(lockPath)) {
        try {
          fs.rmSync(lockPath, { force: true });
          lockFilesRemoved.push(name);
        } catch {
          // Ignore; Chromium may still hold it.
        }
      }
    }
  }

  if (detected.length > 0) {
    logger.warn("[SENDER CONNECT] stale profile lock detected", {
      userDataDir: safeProfileLabel(profileDir),
      processes: detected.map((entry) => entry.name),
      terminatedCount: terminated.length,
      lockFilesRemoved,
    });
  }

  return { detected, terminated, lockFilesRemoved };
}

function channelExecutablePaths(engine: "chrome" | "msedge"): string[] {
  if (process.platform === "win32") {
    return engine === "chrome"
      ? [
          path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
          path.join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
        ]
      : [
          path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
        ];
  }
  if (process.platform === "darwin") {
    return engine === "chrome"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  }
  return engine === "chrome"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
    : ["/usr/bin/microsoft-edge"];
}

function getChannelExecutable(engine: "chrome" | "msedge"): string | null {
  return channelExecutablePaths(engine).find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

function getEngineExecutablePath(engine: EngineKey): string | null {
  if (engine === "bundled") return getBundledChromiumPath();
  return getChannelExecutable(engine);
}

async function launchPersistent(
  profileDir: string,
  headless: boolean,
  mode: SenderSessionMode,
): Promise<LaunchedContext> {
  const bundledPath = getBundledChromiumPath();
  const markerEngine = readEngineMarker(profileDir);
  const chromeDetected = getChannelExecutable("chrome") !== null;
  const edgeDetected = getChannelExecutable("msedge") !== null;
  const channelDetected = chromeDetected || edgeDetected;

  // Engine resolution. The marker is AUTHORITATIVE: once a profile was created
  // by an engine we only ever reopen it with that same engine. A cross-engine
  // fallback is only allowed for a brand-new profile (no marker yet).
  let order: EngineKey[];
  if (markerEngine) {
    order = [markerEngine];
  } else if (bundledPath) {
    order = ["bundled"];
  } else if (chromeDetected || edgeDetected) {
    order = [];
    if (chromeDetected) order.push("chrome");
    if (edgeDetected) order.push("msedge");
  } else {
    order = [];
  }

  if (order.length === 0) {
    logger.error("[SENDER CONNECT] launch failed: no browser available", {
      userDataDir: safeProfileLabel(profileDir),
      bundledChromiumAvailable: Boolean(bundledPath),
      channelBrowserDetected: channelDetected,
    });
    throw new SenderBrowserMissingError();
  }

  logger.info("[SENDER CONNECT] launch parameters", {
    userDataDir: safeProfileLabel(profileDir),
    headless,
    mode,
    bundledChromiumAvailable: Boolean(bundledPath),
    channelBrowserDetected: channelDetected,
    markerEngine,
    preferredEngine: order[0],
    attemptOrder: order,
    playwrightVersion: getPlaywrightVersion(),
    profileDirExists: profileDirExists(profileDir),
  });

  const options = {
    headless,
    viewport: { width: 1280, height: 900 },
  } as const;

  let lastError: unknown = null;
  for (const engine of order) {
    // Marker engine with a now-missing executable is not a profile problem.
    if (engine === "bundled" && !bundledPath) {
      throw new SenderBrowserMissingError();
    }
    if (engine === "chrome" && !chromeDetected) {
      throw new SenderBrowserMissingError(
        "Google Chrome is not installed and this profile was created with it. Run: npx playwright install chromium, then disconnect and reconnect this sender.",
      );
    }
    if (engine === "msedge" && !edgeDetected) {
      throw new SenderBrowserMissingError(
        "Microsoft Edge is not installed and this profile was created with it. Run: npx playwright install chromium, then disconnect and reconnect this sender.",
      );
    }

    const maxAttempts = 3;
    const cleanStaleLock = Boolean(markerEngine);
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      // Stop any stale browser still holding THIS profile before launching.
      // Skipped on the very first launch of a brand-new profile (no marker).
      if (attemptNumber > 1 || cleanStaleLock) {
        cleanupStaleProfileLock(profileDir);
      }

      logger.info("[SENDER CONNECT] launch attempt", {
        engine,
        attempt: attemptNumber,
        headless,
        mode,
        executablePath: getEngineExecutablePath(engine),
        channel: engine === "bundled" ? "chromium" : engine,
      });

      try {
        const context =
          engine === "bundled"
            ? // channel "chromium" forces the full Playwright Chromium build for
              // both headed and headless, instead of the separate
              // chromium-headless-shell package (which may not be installed).
              await chromium.launchPersistentContext(profileDir, {
                ...options,
                channel: "chromium",
              })
            : await chromium.launchPersistentContext(profileDir, {
                ...options,
                channel: engine,
              });

        writeEngineMarker(profileDir, engine);
        logger.info("[SENDER CONNECT] launch succeeded", {
          engine,
          headless,
          mode,
          pagesCount: context.pages().length,
        });
        return { context, engine };
      } catch (error) {
        lastError = error;
        const lockInfo = listProfileLockProcesses(profileDir);
        logger.warn("[SENDER CONNECT] launch failed", {
          engine,
          attempt: attemptNumber,
          mode,
          executablePath: getEngineExecutablePath(engine),
          profileDirExists: profileDirExists(profileDir),
          lockDetected: lockInfo.length > 0,
          lockProcesses: lockInfo.map((entry) => entry.name),
          error: sanitizeReason(error),
        });
        if (attemptNumber < maxAttempts && isTransientLaunchError(error)) {
          await sleep(750 * attemptNumber);
          continue;
        }
        break;
      }
    }
  }

  // Structured diagnostics for the final failure (sanitized; no secrets).
  logger.error("[SENDER CONNECT] launch diagnostics", {
    engine: order[0],
    headless,
    mode,
    userDataDir: safeProfileLabel(profileDir),
    profileDirExists: profileDirExists(profileDir),
    markerEngine,
    executablePath: getEngineExecutablePath(order[0]),
    playwrightVersion: getPlaywrightVersion(),
    bundledChromiumAvailable: Boolean(bundledPath),
    channelBrowserDetected: channelDetected,
    lockDetected: listProfileLockProcesses(profileDir).length > 0,
    error: sanitizeReasonFull(lastError),
  });

  // Any persistent-profile launch failure gets the distinct, actionable error
  // (the user recovers by disconnecting and reconnecting to rebuild the profile).
  throw new SenderProfileLaunchFailedError(undefined, lastError);
}

/**
 * Best-effort read of the authenticated Instagram username. Tries the account
 * settings username field first, then the logged-in navigation profile link.
 * Returns null when it cannot be read safely; callers decide how to handle it.
 */
async function detectInstagramUsername(context: BrowserContext): Promise<string | null> {
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto("https://www.instagram.com/accounts/edit/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    if (!isLoginUrl(page.url()) && !isChallengeUrl(page.url())) {
      const input = page.locator('input[name="username"]').first();
      if ((await input.count()) > 0) {
        const value = (await input.inputValue().catch(() => "")).trim();
        if (/^[A-Za-z0-9._]{1,30}$/.test(value)) {
          return value;
        }
      }
    }
  } catch {
    // Fall through to the navigation heuristic.
  }

  try {
    await page.goto(INSTAGRAM_HOME, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const hrefs = await page.$$eval('a[href]', (elements) =>
      elements.map((el) => el.getAttribute("href") ?? ""),
    );
    for (const href of hrefs) {
      const match = /^\/([A-Za-z0-9._]{1,30})\/$/.exec(href);
      if (match && !RESERVED_PATH_SEGMENTS.has(match[1].toLowerCase())) {
        return match[1];
      }
    }
  } catch {
    // Ignore; username is best-effort.
  }

  return null;
}

class PlaywrightSenderSession implements SenderBrowserSession {
  readonly id: string;
  readonly mode: SenderSessionMode;
  readonly headed: boolean;
  readonly context: BrowserContext;
  readonly engine: EngineKey;

  constructor(context: BrowserContext, mode: SenderSessionMode, engine: EngineKey) {
    this.context = context;
    this.mode = mode;
    this.engine = engine;
    this.headed = mode === "manual-login";
    this.id = `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  isClosed(): boolean {
    try {
      // Accessing pages throws once the context is closed.
      this.context.pages();
      return false;
    } catch {
      return true;
    }
  }

  private async getOrCreatePage(): Promise<Page> {
    return this.context.pages()[0] ?? (await this.context.newPage());
  }

  async focusPage(): Promise<void> {
    if (this.isClosed()) return;
    try {
      const page = await this.getOrCreatePage();
      // Playwright cannot guarantee OS-level foreground on every platform.
      // bringToFront focuses the page within the browser; if the OS keeps the
      // window behind another app, that is outside Playwright's control.
      await page.bringToFront().catch(() => undefined);
      logger.info("[SENDER CONNECT] interactive page ready", {
        pageCount: this.context.pages().length,
        pageUrl: safeUrl(page.url()),
        headed: this.headed,
      });
    } catch (error) {
      logger.warn("[SENDER CONNECT] focus failed", {
        error: sanitizeReason(error),
      });
    }
  }

  async openInstagram(): Promise<SenderNavigationResult> {
    if (this.isClosed()) {
      return { ok: false, url: null, error: "The browser session is closed." };
    }
    try {
      const page = await this.getOrCreatePage();
      await page.bringToFront().catch(() => undefined);
      logger.info("[SENDER CONNECT] interactive page ready", {
        pageCount: this.context.pages().length,
        pageUrl: safeUrl(page.url()),
        headed: this.headed,
      });

      logger.info("[SENDER CONNECT] navigating to Instagram", {
        headed: this.headed,
      });
      await page.goto(INSTAGRAM_HOME, {
        waitUntil: "domcontentloaded",
        timeout: MANUAL_LOGIN_NAV_TIMEOUT_MS,
      });
      await page.bringToFront().catch(() => undefined);

      const url = safeUrl(page.url());
      logger.info("[SENDER CONNECT] Instagram opened", {
        pageUrl: url,
        pagesCount: this.context.pages().length,
        headed: this.headed,
      });

      const diagnostics = await this.diagnostics();
      logger.info("[SENDER CONNECT] visibility diagnostics", {
        contextClosed: diagnostics.isClosed,
        pageClosed: diagnostics.pageClosed,
        pagesCount: diagnostics.pagesCount,
        currentUrl: diagnostics.currentUrl,
        viewport: diagnostics.viewport,
        browserName: diagnostics.browserName,
        browserVersion: diagnostics.browserVersion,
        headed: diagnostics.headed,
      });

      return { ok: true, url };
    } catch (error) {
      return { ok: false, url: null, error: sanitizeReason(error) };
    }
  }

  async diagnostics(): Promise<SenderSessionDiagnostics> {
    let isClosed = false;
    try {
      this.context.pages();
    } catch {
      isClosed = true;
    }

    let pagesCount = 0;
    let currentUrl: string | null = null;
    let pageClosed = false;
    let viewport: { width: number; height: number } | null = null;

    if (!isClosed) {
      try {
        const pages = this.context.pages();
        pagesCount = pages.length;
        const page = pages[0];
        if (page) {
          if (page.isClosed()) {
            pageClosed = true;
          } else {
            currentUrl = safeUrl(page.url());
            viewport = page.viewportSize();
          }
        }
      } catch {
        // Diagnostics are best-effort.
      }
    }

    let browserName: string | null = null;
    let browserVersion: string | null = null;
    try {
      const browser = this.context.browser();
      browserName = browser?.browserType().name() ?? null;
      browserVersion = browser?.version() ?? null;
    } catch {
      // Context closed.
    }

    return {
      live: !isClosed,
      mode: this.mode,
      headed: this.headed,
      browserName,
      browserVersion,
      pagesCount,
      currentUrl,
      isClosed,
      pageClosed,
      viewport,
    };
  }

  async probeAuth(): Promise<SenderAuthProbe> {
    if (this.isClosed()) {
      return {
        authenticated: false,
        username: null,
        code: "SESSION_UNAVAILABLE",
        reason: "The Instagram browser session is closed.",
      };
    }

    try {
      const page: Page = await this.getOrCreatePage();
      await page.goto(INSTAGRAM_HOME, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      const url = page.url();
      if (isChallengeUrl(url)) {
        return {
          authenticated: false,
          username: null,
          code: "CHALLENGE_DETECTED",
          reason:
            "Instagram presented a security challenge. Complete it manually in the browser.",
        };
      }
      if (isLoginUrl(url)) {
        return {
          authenticated: false,
          username: null,
          code: "AUTH_REQUIRED",
          reason: "Instagram requires login for this account.",
        };
      }

      const cookies = await this.context.cookies("https://www.instagram.com");
      const hasSessionCookie = cookies.some(
        (cookie) => cookie.name === "sessionid" && cookie.value.length > 0,
      );
      if (!hasSessionCookie) {
        return {
          authenticated: false,
          username: null,
          code: "AUTH_REQUIRED",
          reason: "No active Instagram session cookie was found.",
        };
      }

      const username = await detectInstagramUsername(this.context).catch(() => null);
      return {
        authenticated: true,
        username,
        code: "OK",
        reason: username
          ? `Authenticated Instagram session detected (@${username}).`
          : "Authenticated Instagram session detected.",
      };
    } catch (error) {
      return {
        authenticated: false,
        username: null,
        code: "BROWSER_ERROR",
        reason: `Failed to inspect the Instagram session: ${sanitizeReason(error)}`,
      };
    }
  }

  onClose(callback: () => void): void {
    this.context.on("close", callback);
  }

  async close(): Promise<void> {
    try {
      await this.context.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Production driver backed by Playwright persistent contexts. One profile
 * directory per sender account; the user's normal browser profile is never used.
 * Interactive login is always a genuinely headed persistent context
 * (`headless: false` + `launchPersistentContext`); `browser.newContext()` is
 * never used for sender login.
 */
export class PlaywrightSenderSessionDriver implements SenderSessionDriver {
  readonly name = "playwright";

  async launchInteractive(profileDir: string): Promise<SenderBrowserSession> {
    const { context, engine } = await launchPersistent(profileDir, false, "manual-login");
    return new PlaywrightSenderSession(context, "manual-login", engine);
  }

  async launchHeadless(profileDir: string): Promise<SenderBrowserSession> {
    const { context, engine } = await launchPersistent(profileDir, true, "headless");
    return new PlaywrightSenderSession(context, "headless", engine);
  }

  async ensureAvailable(): Promise<BrowserAvailability> {
    const bundledChromiumAvailable = Boolean(getBundledChromiumPath());
    const channelBrowserDetected = detectChannelBrowser();
    const availability: BrowserAvailability = {
      bundledChromiumAvailable,
      preferredEngine: bundledChromiumAvailable ? "bundled" : null,
      channelBrowserDetected,
    };
    if (!bundledChromiumAvailable && !channelBrowserDetected) {
      logger.error("[SENDER VERIFY] browser launch failed", {
        reason: "no-browser-available",
        bundledChromiumAvailable,
        channelBrowserDetected,
      });
      throw new SenderBrowserMissingError();
    }
    return availability;
  }
}
