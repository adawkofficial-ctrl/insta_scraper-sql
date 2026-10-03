import "server-only";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import {
  findSenderAccountById,
  updateSenderAccountRecord,
} from "./instagram-sender-repository";
import { ensureSenderSessionDir } from "./sender-session-paths";
import { PlaywrightSenderSessionDriver } from "./playwright-session-driver";
import type {
  BrowserAvailability,
  SenderAuthProbe,
  SenderBrowserSession,
  SenderSessionDiagnostics,
  SenderSessionDriver,
  SenderSessionMode,
} from "./sender-session-driver";

/** Headless messaging sessions are closed after this idle window. */
const DEFAULT_IDLE_CLOSE_MS = 60_000;

/**
 * Safety limit for a headed manual-login browser. It is deliberately long: the
 * browser must stay open until the user finishes authenticating. Never use the
 * short messaging idle window for manual login.
 */
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 15 * 60_000;

/** Reasons a managed browser session may be closed (used for structured logs). */
export type SenderSessionCloseReason =
  | "replaced-by-new-connect"
  | "verify-complete"
  | "disconnect"
  | "duplicate-sender-cleanup"
  | "idle-timeout"
  | "manual-login-timeout"
  | "browser-closed-by-user"
  | "navigation-failed"
  | "user-cancelled"
  | "process-shutdown"
  | "unspecified";

type ManagedEntry = {
  senderAccountId: string;
  session: SenderBrowserSession;
  mode: SenderSessionMode;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  manualLoginTimer: NodeJS.Timeout | null;
  createdAt: number;
  lastActivityAt: number;
  manualLoginExpiresAt: number | null;
};

export type ManagedSessionInfo = {
  senderAccountId: string;
  mode: SenderSessionMode;
  refCount: number;
  createdAt: number;
  lastActivityAt: number;
  manualLoginExpiresAt: number | null;
  manualLoginTimerActive: boolean;
};

export type SenderSessionTimeouts = {
  idleCloseMs: number;
  manualLoginTimeoutMs: number;
};

function readManualLoginTimeoutMs(): number {
  const raw = getServerEnv("INSTAGRAM_MANUAL_LOGIN_TIMEOUT_MS");
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1000) {
    return parsed;
  }
  return DEFAULT_MANUAL_LOGIN_TIMEOUT_MS;
}

/**
 * Owns at most one live browser context per sender account.
 *
 * Lifecycle rules:
 * - `manual-login` (headed) sessions are NEVER closed by the idle timer. They
 *   stay open until the user verifies, disconnects, closes the browser, the
 *   long `INSTAGRAM_MANUAL_LOGIN_TIMEOUT_MS` safety limit is reached, or the
 *   process actually shuts down (SIGTERM/SIGINT).
 * - `headless` (messaging) sessions are reused and closed after an idle window.
 * - Launching is single-flight: concurrent callers share one browser.
 */
export class SenderSessionManager {
  private driver: SenderSessionDriver;
  private entries = new Map<string, ManagedEntry>();
  private launching = new Map<string, Promise<SenderBrowserSession>>();
  private shutdownRegistered = false;
  private timeouts: SenderSessionTimeouts = {
    idleCloseMs: DEFAULT_IDLE_CLOSE_MS,
    manualLoginTimeoutMs: readManualLoginTimeoutMs(),
  };

  constructor(driver: SenderSessionDriver = new PlaywrightSenderSessionDriver()) {
    this.driver = driver;
  }

  /** Test/architecture hook: replace the browser driver (pass null to restore). */
  setDriver(driver: SenderSessionDriver | null): void {
    this.driver = driver ?? new PlaywrightSenderSessionDriver();
  }

  /** Test hook: override idle/manual-login timeouts. */
  setTimeouts(timeouts: Partial<SenderSessionTimeouts>): void {
    this.timeouts = {
      idleCloseMs: timeouts.idleCloseMs ?? this.timeouts.idleCloseMs,
      manualLoginTimeoutMs:
        timeouts.manualLoginTimeoutMs ?? this.timeouts.manualLoginTimeoutMs,
    };
  }

  getDriverName(): string {
    return this.driver.name;
  }

  /**
   * Explicit pre-check before any launch. Throws SenderBrowserMissingError when
   * no usable browser exists (surfaced to the API as PLAYWRIGHT_BROWSER_MISSING).
   */
  async ensureBrowserAvailable(): Promise<BrowserAvailability> {
    return this.driver.ensureAvailable();
  }

  getManagedSessionInfo(senderAccountId: string): ManagedSessionInfo | null {
    const entry = this.entries.get(senderAccountId);
    if (!entry) return null;
    return {
      senderAccountId: entry.senderAccountId,
      mode: entry.mode,
      refCount: entry.refCount,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      manualLoginExpiresAt: entry.manualLoginExpiresAt,
      manualLoginTimerActive: entry.manualLoginTimer !== null,
    };
  }

  private registerShutdownHooks(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    // NOTE: intentionally NOT using "beforeExit". In the Next.js dev runtime the
    // event loop drains between requests and beforeExit fired right after the
    // /connect response, closing the headed manual-login browser after a few
    // seconds. Manual login depends on that browser staying open.
    const shutdown = (): void => {
      void this.shutdown("process-shutdown");
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }

  private async resolveProfileDir(senderAccountId: string): Promise<string> {
    const sender = await findSenderAccountById(senderAccountId);
    if (!sender) {
      throw new Error(`Instagram sender account "${senderAccountId}" was not found.`);
    }
    return ensureSenderSessionDir(sender.sessionPath);
  }

  private clearIdleTimer(entry: ManagedEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private clearManualLoginTimer(entry: ManagedEntry): void {
    if (entry.manualLoginTimer) {
      clearTimeout(entry.manualLoginTimer);
      entry.manualLoginTimer = null;
    }
    entry.manualLoginExpiresAt = null;
  }

  /**
   * Idle-close applies to messaging (headless) sessions only. A manual-login
   * browser must never be closed by this path.
   */
  private scheduleIdleClose(senderAccountId: string): void {
    const entry = this.entries.get(senderAccountId);
    if (!entry) return;
    if (entry.mode === "manual-login") {
      logger.info("[SENDER SESSION] idle close skipped for manual-login", {
        senderAccountId,
        mode: entry.mode,
      });
      return;
    }
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      const current = this.entries.get(senderAccountId);
      if (current && current.refCount === 0) {
        void this.closeSession(senderAccountId, "idle-timeout");
      }
    }, this.timeouts.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  private scheduleManualLoginTimeout(senderAccountId: string, entry: ManagedEntry): void {
    this.clearManualLoginTimer(entry);
    entry.manualLoginExpiresAt =
      Date.now() + this.timeouts.manualLoginTimeoutMs;
    entry.manualLoginTimer = setTimeout(() => {
      const current = this.entries.get(senderAccountId);
      if (!current || current.mode !== "manual-login") return;
      void this.handleManualLoginTimeout(senderAccountId);
    }, this.timeouts.manualLoginTimeoutMs);
    entry.manualLoginTimer.unref?.();
    logger.info("[SENDER SESSION] manual-login safety timeout armed", {
      senderAccountId,
      timeoutMs: this.timeouts.manualLoginTimeoutMs,
    });
  }

  private attachCloseListener(
    senderAccountId: string,
    session: SenderBrowserSession,
  ): void {
    session.onClose(() => {
      void this.handleUnexpectedClose(senderAccountId, session);
    });
  }

  private async launchSingleFlight(
    senderAccountId: string,
    mode: SenderSessionMode,
    launch: () => Promise<SenderBrowserSession>,
  ): Promise<SenderBrowserSession> {
    const existing = this.launching.get(senderAccountId);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const session = await launch();
      const now = Date.now();
      this.entries.set(senderAccountId, {
        senderAccountId,
        session,
        mode,
        refCount: 0,
        idleTimer: null,
        manualLoginTimer: null,
        createdAt: now,
        lastActivityAt: now,
        manualLoginExpiresAt: null,
      });
      this.attachCloseListener(senderAccountId, session);
      logger.info("[SENDER] browser session opened", {
        senderAccountId,
        mode,
        driver: this.driver.name,
      });
      return session;
    })().finally(() => {
      this.launching.delete(senderAccountId);
    });

    this.launching.set(senderAccountId, promise);
    return promise;
  }

  /**
   * Returns true when a live interactive (manual-login) session exists.
   */
  isInteractiveLoginActive(senderAccountId: string): boolean {
    return this.getInteractiveSession(senderAccountId) !== null;
  }

  /**
   * Opens or reuses the headed browser for manual Instagram login.
   *
   * IMPORTANT: repeated /connect calls for the SAME sender account must NOT
   * launch another browser. If a live manual-login session already exists it is
   * reused (focused, not replaced). Pass `{ force: true }` only for an explicit
   * user "reconnect".
   */
  async startInteractiveLogin(
    senderAccountId: string,
    options: { force?: boolean } = {},
  ): Promise<SenderBrowserSession> {
    this.registerShutdownHooks();

    const existing = this.entries.get(senderAccountId);
    if (
      !options.force &&
      existing &&
      existing.mode === "manual-login" &&
      !existing.session.isClosed()
    ) {
      existing.lastActivityAt = Date.now();
      logger.info("[SENDER SESSION] reusing existing manual-login session", {
        senderAccountId,
        mode: existing.mode,
      });
      await existing.session.focusPage().catch(() => undefined);
      return existing.session;
    }

    // Nothing live to reuse (or explicit reconnect): replace safely.
    await this.closeSession(senderAccountId, "replaced-by-new-connect");
    const profileDir = await this.resolveProfileDir(senderAccountId);
    const session = await this.launchSingleFlight(senderAccountId, "manual-login", () =>
      this.driver.launchInteractive(profileDir),
    );
    const entry = this.entries.get(senderAccountId);
    if (entry && entry.mode === "manual-login") {
      this.scheduleManualLoginTimeout(senderAccountId, entry);
    }
    return session;
  }

  /**
   * Explicitly cancels a manual login the user no longer wants open.
   * The profile is preserved; the account becomes AUTH_REQUIRED.
   */
  async cancelInteractiveLogin(senderAccountId: string): Promise<void> {
    await this.closeSession(senderAccountId, "user-cancelled");
    await this.markConnectingAsAuthRequired(
      senderAccountId,
      "Login was cancelled. Click Connect again when you are ready.",
    );
  }

  /** Safe, non-secret diagnostics for a live session (or null when none). */
  async getSessionDiagnostics(
    senderAccountId: string,
  ): Promise<SenderSessionDiagnostics | null> {
    const entry = this.entries.get(senderAccountId);
    if (!entry) return null;
    if (entry.session.isClosed()) return null;
    try {
      return await entry.session.diagnostics();
    } catch {
      return null;
    }
  }

  /**
   * Returns a live session for the account, launching a headless context on
   * demand. Reuses an existing manual-login context when present so verification
   * can read the cookies from the browser the user just logged into.
   * Callers MUST call `release` when finished.
   */
  async getSession(senderAccountId: string): Promise<SenderBrowserSession> {
    this.registerShutdownHooks();

    const existing = this.entries.get(senderAccountId);
    if (existing) {
      if (!existing.session.isClosed()) {
        this.clearIdleTimer(existing);
        existing.refCount += 1;
        existing.lastActivityAt = Date.now();
        return existing.session;
      }
      // Crashed/closed: drop and relaunch below.
      this.entries.delete(senderAccountId);
      logger.warn("[SENDER] cached browser session was closed; relaunching", {
        senderAccountId,
      });
    }

    // Reopen the SAME persistent profile, but only if a browser exists.
    await this.driver.ensureAvailable();
    const profileDir = await this.resolveProfileDir(senderAccountId);
    const session = await this.launchSingleFlight(senderAccountId, "headless", () =>
      this.driver.launchHeadless(profileDir),
    );

    const entry = this.entries.get(senderAccountId);
    if (entry) {
      this.clearIdleTimer(entry);
      entry.refCount += 1;
      entry.lastActivityAt = Date.now();
    }
    return session;
  }

  /** Decrements the reference count; idle-close is scheduled at zero (headless only). */
  release(senderAccountId: string): void {
    const entry = this.entries.get(senderAccountId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastActivityAt = Date.now();
    if (entry.refCount === 0) {
      this.scheduleIdleClose(senderAccountId);
    }
  }

  /** Returns the open interactive (manual-login) session, if any. */
  getInteractiveSession(senderAccountId: string): SenderBrowserSession | null {
    const entry = this.entries.get(senderAccountId);
    if (!entry || entry.mode !== "manual-login") return null;
    if (entry.session.isClosed()) return null;
    return entry.session;
  }

  /**
   * Probes the account's Instagram authentication state, reusing the open
   * manual-login browser when available (so freshly entered cookies are seen).
   */
  async probeAuth(senderAccountId: string): Promise<SenderAuthProbe> {
    this.registerShutdownHooks();

    const interactive = this.getInteractiveSession(senderAccountId);
    if (interactive) {
      const entry = this.entries.get(senderAccountId);
      if (entry) {
        entry.lastActivityAt = Date.now();
      }
      logger.info("[SENDER VERIFY] reusing live interactive session", {
        senderAccountId,
      });
      return interactive.probeAuth();
    }

    // No live manual-login browser: reopen the SAME persistent profile so the
    // cookies from the completed manual login are used.
    logger.info("[SENDER VERIFY] using persistent profile", {
      senderAccountId,
      mode: "headless",
    });
    const session = await this.getSession(senderAccountId);
    try {
      return await session.probeAuth();
    } finally {
      this.release(senderAccountId);
    }
  }

  /**
   * Closes a tracked session with a structured reason. Entry is removed before
   * the browser closes so the "closed" event cannot be mistaken for a manual
   * user close.
   */
  async closeSession(
    senderAccountId: string,
    reason: SenderSessionCloseReason = "unspecified",
  ): Promise<void> {
    const entry = this.entries.get(senderAccountId);
    if (!entry) return;
    logger.info("[SENDER SESSION] close requested", {
      reason,
      senderAccountId,
      mode: entry.mode,
    });
    this.clearIdleTimer(entry);
    this.clearManualLoginTimer(entry);
    this.entries.delete(senderAccountId);
    await entry.session.close().catch(() => undefined);
    logger.info("[SENDER] browser session closed", {
      senderAccountId,
      mode: entry.mode,
      reason,
    });
  }

  private async handleManualLoginTimeout(senderAccountId: string): Promise<void> {
    logger.warn("[SENDER SESSION] manual-login timeout reached", {
      senderAccountId,
    });
    await this.markConnectingAsAuthRequired(
      senderAccountId,
      "Login session expired. Click Connect again.",
    );
    await this.closeSession(senderAccountId, "manual-login-timeout");
  }

  private async handleUnexpectedClose(
    senderAccountId: string,
    session: SenderBrowserSession,
  ): Promise<void> {
    const entry = this.entries.get(senderAccountId);
    if (!entry || entry.session !== session) {
      // Intentional closeSession() already removed the entry.
      return;
    }
    logger.info("[SENDER SESSION] browser closed by user", {
      reason: "browser-closed-by-user",
      senderAccountId,
      mode: entry.mode,
    });
    this.clearIdleTimer(entry);
    this.clearManualLoginTimer(entry);
    this.entries.delete(senderAccountId);
    if (entry.mode === "manual-login") {
      await this.markConnectingAsAuthRequired(
        senderAccountId,
        "Instagram browser was closed before verification.",
      );
    }
  }

  /** CONNECTING -> AUTH_REQUIRED so an interrupted login never sticks. */
  private async markConnectingAsAuthRequired(
    senderAccountId: string,
    message: string,
  ): Promise<void> {
    try {
      const sender = await findSenderAccountById(senderAccountId);
      if (!sender) return;
      if (sender.status !== "CONNECTING") return;
      await updateSenderAccountRecord(senderAccountId, {
        status: "AUTH_REQUIRED",
        lastError: message,
      });
      logger.info("[SENDER SESSION] status updated to AUTH_REQUIRED", {
        senderAccountId,
      });
    } catch (error) {
      logger.warn("[SENDER SESSION] failed to update sender status", {
        senderAccountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Graceful shutdown — only called on real process signals. */
  async shutdown(reason: SenderSessionCloseReason = "process-shutdown"): Promise<void> {
    const ids = Array.from(this.entries.keys());
    await Promise.all(ids.map((id) => this.closeSession(id, reason)));
  }
}

let manager: SenderSessionManager | null = null;

export function getSenderSessionManager(): SenderSessionManager {
  if (!manager) {
    manager = new SenderSessionManager();
  }
  return manager;
}

export function setSenderSessionDriver(
  driver: SenderSessionDriver | null,
): void {
  getSenderSessionManager().setDriver(driver);
}
