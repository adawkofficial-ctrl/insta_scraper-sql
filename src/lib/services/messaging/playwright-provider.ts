import path from "node:path";
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSenderSessionManager } from "../senders/sender-session-manager";
import {
  sendInstagramDirectMessage,
  type DmSendDiagnostics,
} from "./instagram-dm";
import type {
  MessagingProvider,
  MessagingProviderStatus,
  SendMessageRequest,
  SendMessageResult,
} from "./messaging-provider";

/** Result of a page-level send attempt, before it is wrapped by the provider. */
type PageSendOutcome =
  | { success: true }
  | { success: false; code: string; message: string };

export class PlaywrightMessagingProvider implements MessagingProvider {
  readonly name = "playwright";

  private getProfileDir(): string {
    const customDir = getServerEnv("INSTAGRAM_BROWSER_PROFILE_DIR");
    if (customDir) {
      return path.isAbsolute(customDir)
        ? customDir
        : path.resolve(process.cwd(), customDir);
    }
    return path.resolve(process.cwd(), ".browser_profile");
  }

  private hasProfileDirectory(): boolean {
    const dir = this.getProfileDir();
    try {
      if (!fs.existsSync(dir)) return false;
      const files = fs.readdirSync(dir);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  private async launchContext(): Promise<BrowserContext> {
    const profileDir = this.getProfileDir();

    // Ensure parent directory exists
    fs.mkdirSync(profileDir, { recursive: true });

    // Try system chrome channel first, fallback to msedge or default
    try {
      return await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless: true,
        viewport: { width: 1280, height: 800 },
      });
    } catch {
      try {
        return await chromium.launchPersistentContext(profileDir, {
          channel: "msedge",
          headless: true,
          viewport: { width: 1280, height: 800 },
        });
      } catch {
        return await chromium.launchPersistentContext(profileDir, {
          headless: true,
          viewport: { width: 1280, height: 800 },
        });
      }
    }
  }

  async connect(): Promise<void> {
    // Verified lazily per operation to avoid keeping persistent headless instances open
  }

  async disconnect(): Promise<void> {
    // Contexts are cleanly closed after each single test message operation
  }

  async getStatus(): Promise<MessagingProviderStatus> {
    if (!this.hasProfileDirectory()) {
      return {
        provider: this.name,
        authenticated: false,
        status: "AUTH_REQUIRED",
        message:
          "Instagram browser profile directory does not exist or has not been authenticated.",
      };
    }

    let context: BrowserContext | null = null;
    try {
      context = await this.launchContext();
      const cookies = await context.cookies("https://www.instagram.com");
      const hasSessionCookie = cookies.some(
        (c) => c.name === "sessionid" && Boolean(c.value),
      );

      if (!hasSessionCookie) {
        return {
          provider: this.name,
          authenticated: false,
          status: "AUTH_REQUIRED",
          message:
            "No active Instagram session found in browser profile. Manual login required.",
        };
      }

      return {
        provider: this.name,
        authenticated: true,
        status: "READY",
        message: "Authenticated browser session is ready for single test messaging.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        provider: this.name,
        authenticated: false,
        status: "ERROR",
        message: `Failed to inspect browser session: ${message}`,
      };
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    if (request.senderAccountId) {
      return this.sendWithSenderAccount(request, request.senderAccountId);
    }
    return this.sendWithLegacyProfile(request);
  }

  /**
   * Dispatches through a specific sender account's dedicated Playwright session.
   * The session manager guarantees one reusable context per account.
   */
  private async sendWithSenderAccount(
    request: SendMessageRequest,
    senderAccountId: string,
  ): Promise<SendMessageResult> {
    const manager = getSenderSessionManager();
    let session;
    try {
      session = await manager.getSession(senderAccountId);
    } catch {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "SESSION_UNAVAILABLE",
          message:
            "The Instagram sender account session is unavailable. Verify the sender account.",
        },
      };
    }

    try {
      const probe = await session.probeAuth();
      if (!probe.authenticated) {
        return {
          success: false,
          provider: this.name,
          messageText: request.message,
          error: {
            code:
              probe.code === "CHALLENGE_DETECTED" ? "CAPTCHA_REQUIRED" : "AUTH_REQUIRED",
            message: probe.reason,
          },
        };
      }

      const page = session.context.pages()[0] ?? (await session.context.newPage());
      const outcome = await this.performSend(page, request, probe.authenticated);
      if (!outcome.success) {
        return {
          success: false,
          provider: this.name,
          messageText: request.message,
          error: { code: outcome.code, message: outcome.message },
        };
      }
      return {
        success: true,
        provider: this.name,
        messageText: request.message,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "BROWSER_ERROR",
          message: `Browser message dispatch encountered an error: ${message}`,
        },
      };
    } finally {
      manager.release(senderAccountId);
    }
  }

  /** Legacy path: global browser profile (no sender account configured). */
  private async sendWithLegacyProfile(
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    const status = await this.getStatus();
    if (!status.authenticated || status.status !== "READY") {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "AUTH_REQUIRED",
          message:
            status.message ||
            "Instagram session not authenticated in the browser profile.",
        },
      };
    }

    let context: BrowserContext | null = null;
    try {
      context = await this.launchContext();
      const page = context.pages()[0] || (await context.newPage());
      const outcome = await this.performSend(page, request, status.authenticated);
      if (!outcome.success) {
        return {
          success: false,
          provider: this.name,
          messageText: request.message,
          error: { code: outcome.code, message: outcome.message },
        };
      }
      return {
        success: true,
        provider: this.name,
        messageText: request.message,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "BROWSER_ERROR",
          message: `Browser message dispatch encountered an error: ${message}`,
        },
      };
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
    }
  }

  /** Shared page-level flow: open profile, open composer, submit message. */
  private async performSend(
    page: Page,
    request: SendMessageRequest,
    authenticated: boolean,
  ): Promise<PageSendOutcome> {
    const outcome = await sendInstagramDirectMessage({
      page,
      profileUrl: request.profileUrl,
      message: request.message,
      authenticated,
      pagesCount: page.context().pages().length,
    });

    this.logDmDiagnostics(outcome.diagnostics, outcome.success ? null : outcome.code);

    if (outcome.success) {
      return { success: true };
    }
    return { success: false, code: outcome.code, message: outcome.message };
  }

  /** Sanitized DM diagnostics: no cookies, tokens, or message content. */
  private logDmDiagnostics(
    diagnostics: DmSendDiagnostics,
    detectedCode: string | null,
  ): void {
    logger.info("[MESSAGE][DM] diagnostics", {
      detectedCode,
      classificationSource: diagnostics.classificationSource,
      recipientUsername: diagnostics.recipientUsername,
      currentUrl: diagnostics.currentUrl,
      pageTitle: diagnostics.pageTitle,
      authenticated: diagnostics.authenticated,
      pagesCount: diagnostics.pagesCount,
      navigationSucceeded: diagnostics.navigationSucceeded,
      pageState: diagnostics.pageState,
      restrictionUiDetected: diagnostics.restrictionUiDetected,
      messageActionExisted: diagnostics.messageActionFound !== null,
      conversationReached: diagnostics.conversationUiDetected,
      messageActionFound: diagnostics.messageActionFound,
      composerFound: diagnostics.composerFound,
      composerCandidates: diagnostics.composerCandidates,
      messageActionCandidates: diagnostics.messageActionCandidates,
    });
  }
}
