import type { BrowserContext } from "playwright";

/** Result of probing whether a browser context still holds an Instagram session. */
export type SenderAuthProbe = {
  authenticated: boolean;
  username: string | null;
  code:
    | "OK"
    | "AUTH_REQUIRED"
    | "SESSION_UNAVAILABLE"
    | "CHALLENGE_DETECTED"
    | "BROWSER_ERROR";
  /** Sanitized, user-safe reason. Never contains cookies or page HTML. */
  reason: string;
};

export type SenderSessionMode = "manual-login" | "headless";

/** Actionable message shown when the preferred Playwright browser is absent. */
export const PLAYWRIGHT_CHROMIUM_INSTALL_HINT =
  "Playwright Chromium is not installed. Run: npx playwright install chromium";

export const SENDER_PROFILE_RECOVERY_HINT =
  "The saved Instagram browser profile could not be opened. Disconnect this sender and reconnect it to create a fresh profile.";

/**
 * Thrown when Playwright's own Chromium (and any optional Chrome/Edge fallback)
 * is not available. Surfaced to the API as PLAYWRIGHT_BROWSER_MISSING.
 */
export class SenderBrowserMissingError extends Error {
  readonly code = "PLAYWRIGHT_BROWSER_MISSING";
  constructor(message: string = PLAYWRIGHT_CHROMIUM_INSTALL_HINT) {
    super(message);
    this.name = "SenderBrowserMissingError";
  }
}

/**
 * Thrown when a browser exists but the persistent context could not be opened
 * (e.g. profile locked, process crashed). Never treated as AUTH_REQUIRED.
 */
export class SenderBrowserLaunchError extends Error {
  readonly code = "BROWSER_LAUNCH_FAILED";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SenderBrowserLaunchError";
  }
}

export function isSenderBrowserMissingError(
  error: unknown,
): error is SenderBrowserMissingError {
  return error instanceof SenderBrowserMissingError;
}

/**
 * Thrown when the sender's saved persistent profile cannot be opened (locked by
 * a stale process, corrupt, or incompatible). Actionable: disconnect + reconnect.
 */
export class SenderProfileLaunchFailedError extends Error {
  readonly code = "SENDER_PROFILE_LAUNCH_FAILED";
  constructor(
    message: string = SENDER_PROFILE_RECOVERY_HINT,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SenderProfileLaunchFailedError";
  }
}

export function isSenderProfileLaunchFailedError(
  error: unknown,
): error is SenderProfileLaunchFailedError {
  return error instanceof SenderProfileLaunchFailedError;
}

export type BrowserAvailability = {
  bundledChromiumAvailable: boolean;
  /** Sanitized engine key of the last successful launch for this environment. */
  preferredEngine: "bundled" | "chrome" | "msedge" | null;
  channelBrowserDetected: boolean;
};

/** Result of opening Instagram in the sender's browser. */
export type SenderNavigationResult = {
  ok: boolean;
  /** Safe URL (origin + path only; never query/hash). */
  url: string | null;
  error?: string;
};

/** Safe, non-secret diagnostics about a live session (never exposes userDataDir). */
export type SenderSessionDiagnostics = {
  live: boolean;
  mode: SenderSessionMode;
  headed: boolean;
  browserName: string | null;
  browserVersion: string | null;
  pagesCount: number;
  currentUrl: string | null;
  isClosed: boolean;
  pageClosed: boolean;
  viewport: { width: number; height: number } | null;
};

/** A single live Playwright persistent context bound to one sender account. */
export type SenderBrowserSession = {
  id: string;
  mode: SenderSessionMode;
  /** True for headed (interactive) contexts; false for headless messaging. */
  headed: boolean;
  context: BrowserContext;
  isClosed(): boolean;
  /** Navigates Instagram and reports whether the session is authenticated. */
  probeAuth(): Promise<SenderAuthProbe>;
  /** Opens the Instagram login/home page for manual authentication. */
  openInstagram(): Promise<SenderNavigationResult>;
  /** Brings the interactive page to the foreground without navigating. */
  focusPage(): Promise<void>;
  /** Safe, non-secret session diagnostics. */
  diagnostics(): Promise<SenderSessionDiagnostics>;
  /** Registers a callback for when the underlying browser/context closes. */
  onClose(callback: () => void): void;
  close(): Promise<void>;
};

/**
 * Injectable browser driver. The production implementation uses Playwright's
 * persistent contexts; tests inject a controlled mock so no real browser or
 * Instagram traffic is required.
 */
export interface SenderSessionDriver {
  readonly name: string;
  /** Headed context used for interactive, manual Instagram login. */
  launchInteractive(profileDir: string): Promise<SenderBrowserSession>;
  /** Headless context used for verification and message dispatch. */
  launchHeadless(profileDir: string): Promise<SenderBrowserSession>;
  /**
   * Throws SenderBrowserMissingError when no usable browser engine exists.
   * Called before launching so verify surfaces an actionable error.
   */
  ensureAvailable(): Promise<BrowserAvailability>;
}
