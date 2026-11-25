import "server-only";

import { logger } from "@/lib/logger";
import { getPrismaClient } from "@/lib/db/prisma";
import { getUnipileClient, UnipileClient, isUnipileAccountActive, getUnipileAccountUsername } from "../unipile";
import type {
  MessagingProvider,
  MessagingProviderStatus,
  SendMessageRequest,
  SendMessageResult,
} from "./messaging-provider";

export class UnipileMessagingProvider implements MessagingProvider {
  readonly name = "unipile";

  private client: UnipileClient;

  constructor(client?: UnipileClient) {
    this.client = client ?? getUnipileClient();
  }

  async connect(): Promise<void> {
    // Unipile is an HTTP REST API provider; connections are stateless.
  }

  async disconnect(): Promise<void> {
    // No-op for HTTP client
  }

  async getStatus(): Promise<MessagingProviderStatus> {
    if (!this.client.isConfigured) {
      return {
        provider: this.name,
        authenticated: false,
        status: "AUTH_REQUIRED",
        message: "Unipile API credentials (UNIPILE_API_KEY and UNIPILE_DSN) are not configured in .env.",
      };
    }

    try {
      const accounts = await this.client.getAccounts();
      const instagramAccounts = accounts.filter((acc) => {
        const prov = String(acc.provider || acc.type || "").toUpperCase();
        return prov === "INSTAGRAM" || prov === "" || prov === "MESSAGING";
      });

      const active = instagramAccounts.find((acc) => isUnipileAccountActive(acc));

      if (active) {
        const username = getUnipileAccountUsername(active) || active.id;
        return {
          provider: this.name,
          authenticated: true,
          status: "READY",
          message: `Unipile is ready with active Instagram account (@${username}).`,
        };
      }

      if (instagramAccounts.length > 0) {
        const firstIg = instagramAccounts[0];
        const igUser = getUnipileAccountUsername(firstIg) || firstIg.name || firstIg.id;
        return {
          provider: this.name,
          authenticated: false,
          status: "AUTH_REQUIRED",
          message: `Instagram sender account (@${igUser}) requires authentication. Please reconnect in Settings > Instagram Senders.`,
        };
      }

      return {
        provider: this.name,
        authenticated: false,
        status: "AUTH_REQUIRED",
        message: "No connected Instagram sender account found in Unipile. Please connect an account in Settings.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        provider: this.name,
        authenticated: false,
        status: "ERROR",
        message: `Failed to check Unipile status: ${msg}`,
      };
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    if (!this.client.isConfigured) {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "AUTH_REQUIRED",
          message: "Unipile is not configured with valid credentials in .env.",
        },
      };
    }

    // 1. If an existing chatId is supplied, dispatch directly into existing thread
    if (request.chatId) {
      logger.info("[UNIPILE] dispatching reply to existing chat thread", {
        chatId: request.chatId,
        senderAccountId: request.senderAccountId,
      });

      const result = await this.client.sendChatMessage({
        chatId: request.chatId,
        text: request.message,
      });

      if (!result.success) {
        logger.warn("[UNIPILE] chat message dispatch failed", {
          chatId: request.chatId,
          code: result.code,
          error: result.message,
        });

        return {
          success: false,
          provider: this.name,
          messageText: request.message,
          error: {
            code: result.code,
            message: result.message,
          },
        };
      }

      return {
        success: true,
        provider: this.name,
        messageText: request.message,
        providerMessageId: result.messageId,
        sentAt: new Date().toISOString(),
      };
    }

    // 2. Extract target Instagram username for new chat
    const username = UnipileClient.extractUsername(request.profileUrl);
    if (!username) {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "RECIPIENT_NOT_FOUND",
          message: `Invalid or unparseable Instagram profile URL: "${request.profileUrl}".`,
        },
      };
    }

    // 2. Resolve Unipile account_id for the sender
    let unipileAccountId: string | null = null;

    if (request.senderAccountId) {
      unipileAccountId = await this.resolveSenderAccountId(request.senderAccountId);
    }

    // Fallback to the first active Unipile account ONLY when the caller did
    // not name a sender. If a sender was named but can't be resolved, fail:
    // sending from a different account would bypass that account's caps,
    // ledger and warm-up, and DM the lead from the wrong profile.
    if (!unipileAccountId && !request.senderAccountId) {
      const accounts = await this.client.getAccounts();
      const active = accounts.find((acc) => {
        const prov = String(acc.provider || acc.type || "").toUpperCase();
        const isIg = prov === "INSTAGRAM" || prov === "" || prov === "MESSAGING";
        return isIg && isUnipileAccountActive(acc);
      });
      if (active) {
        unipileAccountId = active.id;
      }
    }

    if (!unipileAccountId) {
      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: "AUTH_REQUIRED",
          message: "No active Instagram sender account found in Unipile to dispatch message.",
        },
      };
    }

    // 3. Resolve recipient's Instagram provider messaging ID
    logger.info("[UNIPILE] resolving recipient user", {
      username,
      senderAccountId: unipileAccountId,
    });

    const userProfile = await this.client.resolveInstagramUser(username, unipileAccountId);
    const recipientProviderId =
      userProfile?.provider_id ||
      userProfile?.provider_messaging_id ||
      userProfile?.id ||
      username;

    // 4. Send direct message via Unipile chats
    logger.info("[UNIPILE] dispatching direct message", {
      username,
      recipientProviderId,
      senderAccountId: unipileAccountId,
    });

    const result = await this.client.sendDirectMessage({
      accountId: unipileAccountId,
      recipientProviderId,
      text: request.message,
    });

    if (!result.success) {
      logger.warn("[UNIPILE] dispatch failed", {
        username,
        code: result.code,
        error: result.message,
      });

      return {
        success: false,
        provider: this.name,
        messageText: request.message,
        error: {
          code: result.code,
          message: result.message,
        },
      };
    }

    return {
      success: true,
      provider: this.name,
      messageText: request.message,
      providerMessageId: result.messageId,
      sentAt: new Date().toISOString(),
    };
  }

  private async resolveSenderAccountId(senderAccountId: string): Promise<string | null> {
    try {
      const prisma = getPrismaClient();
      const record = await prisma.instagramSenderAccount.findUnique({
        where: { id: senderAccountId },
      });

      if (!record) return null;

      if (record.unipileAccountId) {
        return record.unipileAccountId;
      }

      // If sessionPath was stored as a Unipile ID (e.g. unipile:acc_xyz or acc_xyz)
      if (record.sessionPath && !record.sessionPath.includes("/") && !record.sessionPath.includes("\\")) {
        return record.sessionPath.replace(/^unipile:/, "");
      }

      // Check if any Unipile account matches by username
      const accounts = await this.client.getAccounts();
      const match = accounts.find(
        (acc) =>
          acc.name?.toLowerCase() === record.username.toLowerCase() ||
          acc.id === record.id ||
          acc.id === record.sessionPath,
      );

      if (match) {
        return match.id;
      }

      return null;
    } catch (err) {
      logger.error("[UNIPILE] error resolving sender account", err as Error);
      return null;
    }
  }
}
