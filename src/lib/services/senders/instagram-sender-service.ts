import "server-only";

import { randomBytes } from "node:crypto";

import { BadRequestError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type {
  InstagramSenderSessionType,
  InstagramSenderStatus,
  ConnectionMethod,
} from "@/generated/prisma/enums";

import {
  countSenderAccountsForUser,
  createSenderAccountRecord,
  deleteSenderAccountRecord,
  findConnectedSenderForUser,
  findSenderAccountOwned,
  findSenderByUsername,
  listSenderAccountsForUser,
  updateSenderAccountRecord,
  type SenderAccountRecord,
} from "./instagram-sender-repository";
import { buildSenderSessionPath, removeSenderSessionDir } from "./sender-session-paths";
import { getSenderSessionManager } from "./sender-session-manager";
import { notifySenderStatusChange } from "../notifications/notification-triggers";
import {
  SenderBrowserLaunchError,
  isSenderBrowserMissingError,
  isSenderProfileLaunchFailedError,
  type SenderSessionDiagnostics,
} from "./sender-session-driver";
import {
  inspectInstagramDmTarget,
  safeDmUrl,
  type DmSendDiagnostics,
} from "../messaging/instagram-dm";

import { getServerEnv } from "@/lib/env";
import {
  getUnipileClient,
  UnipileClient,
  isUnipileAccountActive,
  getUnipileAccountUsername,
} from "../unipile";

const MAX_DISPLAY_NAME_LENGTH = 100;
const INSTAGRAM_USERNAME_PATTERN =
  /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/;

/** Safe sender account shape. Never includes sessionPath or session contents. */
export type SenderAccountDto = {
  id: string;
  username: string;
  displayName: string | null;
  connectionMethod: ConnectionMethod;
  unipileAccountId: string | null;
  sessionType: InstagramSenderSessionType;
  status: InstagramSenderStatus;
  lastVerifiedAt: string | null;
  lastError: string | null;
  isConnected: boolean;
  createdAt: string;
  updatedAt: string;
  /** Live, non-secret browser diagnostics; null when no browser is open. */
  sessionDiagnostics: SenderSessionDiagnostics | null;
};

export function toSenderAccountDto(
  record: SenderAccountRecord,
  diagnostics: SenderSessionDiagnostics | null = null,
): SenderAccountDto {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    connectionMethod: record.connectionMethod ?? "PLAYWRIGHT",
    unipileAccountId: record.unipileAccountId ?? null,
    sessionType: record.sessionType,
    status: record.status,
    lastVerifiedAt: record.lastVerifiedAt ? record.lastVerifiedAt.toISOString() : null,
    lastError: record.lastError,
    isConnected: record.status === "CONNECTED",
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    sessionDiagnostics: diagnostics,
  };
}

async function syncUnipileSenders(
  userId: string,
  records: SenderAccountRecord[],
): Promise<SenderAccountRecord[]> {
  try {
    const unipile = getUnipileClient();
    if (!unipile.isConfigured) return records;

    const accounts = await unipile.getAccounts();
    const instagramAccounts = accounts.filter((acc) => {
      const prov = String(acc.provider || acc.type || "").toUpperCase();
      return prov === "INSTAGRAM" || prov === "" || prov === "MESSAGING";
    });

    const active = instagramAccounts.find((acc) => isUnipileAccountActive(acc));
    if (!active) return records;

    const detectedUsername = getUnipileAccountUsername(active);
    if (!detectedUsername) return records;

    // Check if any record matches this unipile account id or username
    let matched =
      records.find((r) => r.unipileAccountId === active.id || r.sessionPath === `unipile:${active.id}`) ||
      records.find((r) => r.username.toLowerCase() === detectedUsername.toLowerCase());

    if (!matched) {
      // Pick any CONNECTING record or pending record
      matched =
        records.find((r) => r.status === "CONNECTING") ||
        records.find((r) => r.username.startsWith("pending_")) ||
        records[0];
    }

    if (matched) {
      await updateSenderAccountRecord(matched.id, {
        status: "CONNECTED",
        connectionMethod: "UNIPILE",
        unipileAccountId: active.id,
        username: detectedUsername,
        sessionPath: `unipile:${active.id}`,
        lastVerifiedAt: new Date(),
        lastError: null,
      });
    } else {
      await createSenderAccountRecord({
        userId,
        username: detectedUsername,
        displayName: detectedUsername,
        connectionMethod: "UNIPILE",
        unipileAccountId: active.id,
        sessionType: "PERSISTENT_PROFILE",
        sessionPath: `unipile:${active.id}`,
        status: "CONNECTED",
      });
    }

    // Clean up any extra pending records that were created during repeated connect attempts
    const refreshed = await listSenderAccountsForUser(userId);
    const extraPendings = refreshed.filter(
      (r) =>
        r.status === "CONNECTING" &&
        r.username.startsWith("pending_") &&
        r.unipileAccountId !== active.id &&
        r.sessionPath !== `unipile:${active.id}`,
    );
    for (const extra of extraPendings) {
      await deleteSenderAccountRecord(extra.id).catch(() => undefined);
    }

    return await listSenderAccountsForUser(userId);
  } catch (err) {
    logger.warn("[SENDER] error in syncUnipileSenders", {
      error: err instanceof Error ? err.message : String(err),
    });
    return records;
  }
}

export async function listSenderAccounts(userId: string): Promise<SenderAccountDto[]> {
  const manager = getSenderSessionManager();
  const isUnipile = getServerEnv("MESSAGING_PROVIDER")?.toLowerCase() !== "playwright";

  let records = await listSenderAccountsForUser(userId);

  if (isUnipile) {
    const hasConnectingOrPending = records.some(
      (r) => r.status === "CONNECTING" || r.username.startsWith("pending_"),
    );
    if (hasConnectingOrPending) {
      records = await syncUnipileSenders(userId, records);
    }
  }

  return Promise.all(
    records.map(async (record) =>
      toSenderAccountDto(record, await manager.getSessionDiagnostics(record.id)),
    ),
  );
}

export async function getSenderAccount(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountDto> {
  const record = await findSenderAccountOwned(senderAccountId, userId);
  if (!record) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }
  const diagnostics = await getSenderSessionManager().getSessionDiagnostics(record.id);
  return toSenderAccountDto(record, diagnostics);
}

export async function createSenderAccount(
  input: unknown,
  userId: string,
): Promise<SenderAccountDto> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set(["username", "displayName"]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new BadRequestError(
      "UNALLOWED_FIELDS",
      `Cannot set fields: ${unexpected.join(", ")}. Allowed: username, displayName.`,
    );
  }

  let username: string;
  if (record.username !== undefined && record.username !== null) {
    if (typeof record.username !== "string") {
      throw new BadRequestError("INVALID_USERNAME", '"username" must be a string.');
    }
    username = record.username.trim().replace(/^@/, "");
    if (!INSTAGRAM_USERNAME_PATTERN.test(username)) {
      throw new BadRequestError(
        "INVALID_USERNAME",
        '"username" must be a valid Instagram handle (1-30 characters: letters, numbers, "." or "_").',
      );
    }
  } else {
    // Placeholder until the real handle is read from the authenticated session.
    username = `pending_${randomBytes(4).toString("hex")}`;
  }

  let displayName: string | null = null;
  if (record.displayName !== undefined && record.displayName !== null) {
    if (typeof record.displayName !== "string") {
      throw new BadRequestError("INVALID_DISPLAY_NAME", '"displayName" must be a string.');
    }
    const trimmed = record.displayName.trim();
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new BadRequestError(
        "DISPLAY_NAME_TOO_LONG",
        `"displayName" cannot exceed ${MAX_DISPLAY_NAME_LENGTH} characters.`,
      );
    }
    displayName = trimmed.length > 0 ? trimmed : null;
  }

  const created = await createSenderAccountRecord({
    userId,
    username,
    displayName,
    sessionType: "PERSISTENT_PROFILE",
    sessionPath: buildSenderSessionPath(userId, "placeholder"),
    status: "CONNECTING",
  });

  // Rebuild the session path now that the id is known.
  const withPath = await updateSenderAccountRecord(created.id, {
    sessionPath: buildSenderSessionPath(userId, created.id),
  });

  logger.info("[SENDER] sender account created", {
    senderAccountId: withPath.id,
    userId,
  });

  return toSenderAccountDto(withPath);
}

export type ConnectSenderResult = {
  success: true;
  status: "CONNECTING" | "CONNECTED";
  /** True when an existing live browser was reused instead of launching one. */
  reusedExistingSession: boolean;
  sender: SenderAccountDto;
  instructions: string;
  connectUrl?: string;
};


/**
 * Opens or reuses a headed Playwright browser bound to the sender account's
 * dedicated profile directory. The user logs into Instagram manually; no
 * credentials are ever sent to or stored by this application.
 *
 * Repeated calls for the same sender account reuse the live browser and never
 * launch a second one.
 */
export async function startSenderConnect(
  senderAccountId: string,
  userId: string,
): Promise<ConnectSenderResult> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }

  const manager = getSenderSessionManager();

  // Already connected: never launch or navigate anything.
  if (owned.status === "CONNECTED") {
    logger.info("[SENDER SESSION] connect ignored; sender already connected", {
      senderAccountId: owned.id,
    });
    return {
      success: true,
      status: "CONNECTED",
      reusedExistingSession: true,
      sender: await getSenderAccount(owned.id, userId),
      instructions: "This Instagram sender account is already connected.",
    };
  }

  const isUnipile = getServerEnv("MESSAGING_PROVIDER")?.toLowerCase() !== "playwright";
  if (isUnipile) {
    const unipile = getUnipileClient();
    if (!unipile.isConfigured) {
      throw new BadRequestError(
        "AUTH_REQUIRED",
        "Unipile API credentials (UNIPILE_API_KEY and UNIPILE_DSN) are not configured in .env.",
      );
    }

    const connecting =
      owned.status === "CONNECTING"
        ? owned
        : await updateSenderAccountRecord(owned.id, {
            status: "CONNECTING",
            lastError: null,
          });

    try {
      const link = await unipile.createHostedAuthLink({
        name: userId,
      });

      return {
        success: true,
        status: "CONNECTING",
        reusedExistingSession: false,
        sender: toSenderAccountDto(connecting),
        connectUrl: link?.url,
        instructions:
          "Click the Unipile link to authenticate your Instagram account securely.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateSenderAccountRecord(connecting.id, {
        status: "ERROR",
        lastError: msg,
      });
      throw new BadRequestError("UNIPILE_ERROR", msg);
    }
  }

  // A manual-login browser is already open: reuse it, do NOT launch another.

  if (manager.isInteractiveLoginActive(owned.id)) {

    const current =
      owned.status === "CONNECTING"
        ? owned
        : await updateSenderAccountRecord(owned.id, {
            status: "CONNECTING",
            lastError: null,
          });
    logger.info("[SENDER SESSION] connect reusing live manual-login session", {
      senderAccountId: owned.id,
    });
    await manager.startInteractiveLogin(owned.id).catch(() => undefined);
    return {
      success: true,
      status: "CONNECTING",
      reusedExistingSession: true,
      sender: toSenderAccountDto(
        current,
        await manager.getSessionDiagnostics(owned.id),
      ),
      instructions:
        "The Instagram login browser is already open. Finish logging in, then click Verify Session.",
    };
  }

  const connecting =
    owned.status === "CONNECTING"
      ? owned
      : await updateSenderAccountRecord(owned.id, {
          status: "CONNECTING",
          lastError: null,
        });

  let session;
  try {
    session = await manager.startInteractiveLogin(connecting.id);
  } catch (error) {
    if (isSenderBrowserMissingError(error)) {
      logger.warn("[SENDER CONNECT] browser launch failed", {
        senderAccountId: connecting.id,
        code: "PLAYWRIGHT_BROWSER_MISSING",
      });
      await updateSenderAccountRecord(connecting.id, {
        status: "ERROR",
        lastError: error.message,
      });
      throw new BadRequestError("PLAYWRIGHT_BROWSER_MISSING", error.message, {
        cause: error,
      });
    }
    if (isSenderProfileLaunchFailedError(error)) {
      logger.warn("[SENDER CONNECT] profile launch failed", {
        senderAccountId: connecting.id,
        code: "SENDER_PROFILE_LAUNCH_FAILED",
      });
      await updateSenderAccountRecord(connecting.id, {
        status: "ERROR",
        lastError: error.message,
      });
      throw new BadRequestError("SENDER_PROFILE_LAUNCH_FAILED", error.message, {
        cause: error,
      });
    }
    const reason =
      error instanceof SenderBrowserLaunchError
        ? error.message
        : "Could not open the Instagram login browser.";
    logger.warn("[SENDER CONNECT] browser launch failed", {
      senderAccountId: connecting.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await updateSenderAccountRecord(connecting.id, {
      status: "ERROR",
      lastError: reason,
    });
    throw new BadRequestError("BROWSER_ERROR", reason, { cause: error });
  }

  logger.info("[SENDER] account connecting", { senderAccountId: connecting.id, userId });

  // Open Instagram in the headed browser so the user can authenticate. The
  // browser is intentionally left OPEN; this endpoint never closes it.
  const navigation = await session.openInstagram();
  if (!navigation.ok) {
    logger.warn("[SENDER CONNECT] Instagram navigation failed", {
      senderAccountId: connecting.id,
      error: navigation.error,
    });
    await manager
      .closeSession(connecting.id, "navigation-failed")
      .catch(() => undefined);
    await updateSenderAccountRecord(connecting.id, {
      status: "ERROR",
      lastError: "Could not open Instagram for manual login. Please try again.",
    });
    throw new BadRequestError(
      "BROWSER_ERROR",
      `Could not open Instagram for manual login: ${navigation.error ?? "unknown error"}`,
    );
  }

  return {
    success: true,
    status: "CONNECTING",
    reusedExistingSession: false,
    sender: toSenderAccountDto(
      connecting,
      await manager.getSessionDiagnostics(connecting.id),
    ),
    instructions:
      "A browser window opened on Instagram. Log into your authorized Instagram account manually, complete any 2FA or security challenge yourself, then return here and click Verify Session. Leave the browser open until verification succeeds.",
  };
}

/**
 * Connects an Instagram sender account directly using the sessionid cookie.
 * Bypasses Instagram datacenter IP blocks.
 */
export async function connectSenderWithSessionId(
  senderAccountId: string,
  userId: string,
  sessionId: string,
  userAgent?: string,
): Promise<ConnectSenderResult> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }

  const unipile = getUnipileClient();
  if (!unipile.isConfigured) {
    throw new BadRequestError(
      "AUTH_REQUIRED",
      "Unipile API credentials (UNIPILE_API_KEY and UNIPILE_DSN) are not configured in .env.",
    );
  }

  const connectResult = await unipile.connectWithSessionId(sessionId, userAgent);
  if (!connectResult.success) {
    await updateSenderAccountRecord(owned.id, {
      status: "ERROR",
      lastError: connectResult.message,
    });
    throw new BadRequestError("AUTHENTICATION_FAILED", connectResult.message);
  }

  // Retrieve account details from Unipile to verify
  const account = await unipile.getAccount(connectResult.accountId);
  const detectedUsername =
    account?.name ||
    (typeof account?.username === "string" ? account.username : null) ||
    owned.username;

  const verified = await updateSenderAccountRecord(owned.id, {
    status: "CONNECTED",
    connectionMethod: "UNIPILE",
    unipileAccountId: connectResult.accountId,
    username: detectedUsername,
    sessionPath: `unipile:${connectResult.accountId}`,
    lastVerifiedAt: new Date(),
    lastError: null,
  });

  logger.info("[SENDER] connected successfully via sessionid cookie", {
    senderAccountId: verified.id,
    unipileAccountId: connectResult.accountId,
    username: verified.username,
  });

  return {
    success: true,
    status: "CONNECTED",
    reusedExistingSession: false,
    sender: toSenderAccountDto(verified),
    instructions: `Connected as @${verified.username} via Instagram session cookie.`,
  };
}

/**
 * Cancels an in-progress manual login: closes only that sender's interactive

 * browser and moves CONNECTING -> AUTH_REQUIRED. The persisted profile is kept.
 */
export async function cancelSenderLogin(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountDto> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }

  await getSenderSessionManager().cancelInteractiveLogin(owned.id);

  const refreshed = await findSenderAccountOwned(owned.id, userId);
  logger.info("[SENDER] login cancelled", { senderAccountId: owned.id });
  return toSenderAccountDto(refreshed ?? owned, null);
}

export async function verifySenderAccount(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountDto> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }

  const isUnipile =
    owned.connectionMethod === "UNIPILE" ||
    Boolean(owned.unipileAccountId) ||
    owned.sessionPath.startsWith("unipile:") ||
    getServerEnv("MESSAGING_PROVIDER")?.toLowerCase() === "unipile";
  if (isUnipile) {
    const unipile = getUnipileClient();
    if (!unipile.isConfigured) {
      throw new BadRequestError(
        "AUTH_REQUIRED",
        "Unipile API credentials (UNIPILE_API_KEY and UNIPILE_DSN) are not configured in .env.",
      );
    }

    try {
      const accounts = await unipile.getAccounts();
      const instagramAccounts = accounts.filter((acc) => {
        const prov = String(acc.provider || acc.type || "").toUpperCase();
        return prov === "INSTAGRAM" || prov === "" || prov === "MESSAGING";
      });

      const active = instagramAccounts.find((acc) => isUnipileAccountActive(acc));

      if (active) {
        const detectedUsername = getUnipileAccountUsername(active) || owned.username;
        const verified = await updateSenderAccountRecord(owned.id, {
          status: "CONNECTED",
          connectionMethod: "UNIPILE",
          unipileAccountId: active.id,
          username: detectedUsername,
          sessionPath: `unipile:${active.id}`,
          lastVerifiedAt: new Date(),
          lastError: null,
        });

        logger.info("[SENDER] account connected via Unipile", {
          senderAccountId: verified.id,
          unipileAccountId: active.id,
          username: verified.username,
        });

        return toSenderAccountDto(verified);
      }

      const updated = await updateSenderAccountRecord(owned.id, {
        status: "AUTH_REQUIRED",
        lastError:
          "No active Instagram account found in Unipile. Please complete the login using the link.",
      });

      if (owned.status !== "AUTH_REQUIRED") {
        await notifySenderStatusChange({
          userId: owned.userId,
          senderUsername: owned.username,
          previousStatus: owned.status,
          newStatus: "AUTH_REQUIRED",
          errorMessage: "No active Instagram account found in Unipile.",
        }).catch(() => undefined);
      }

      return toSenderAccountDto(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateSenderAccountRecord(owned.id, {
        status: "ERROR",
        lastError: msg,
      });
      await notifySenderStatusChange({
        userId: owned.userId,
        senderUsername: owned.username,
        previousStatus: owned.status,
        newStatus: "ERROR",
        errorMessage: msg,
      }).catch(() => undefined);
      throw new BadRequestError("UNIPILE_ERROR", msg);
    }
  }

  const manager = getSenderSessionManager();

  logger.info("[SENDER] session verification started", { senderAccountId: owned.id });

  let probe;

  try {
    probe = await manager.probeAuth(owned.id);
  } catch (error) {
    if (isSenderBrowserMissingError(error)) {
      logger.warn("[SENDER VERIFY] browser launch failed", {
        senderAccountId: owned.id,
        code: "PLAYWRIGHT_BROWSER_MISSING",
      });
      await updateSenderAccountRecord(owned.id, {
        status: "ERROR",
        lastError: error.message,
      });
      throw new BadRequestError("PLAYWRIGHT_BROWSER_MISSING", error.message, {
        cause: error,
      });
    }
    if (isSenderProfileLaunchFailedError(error)) {
      logger.warn("[SENDER VERIFY] profile launch failed", {
        senderAccountId: owned.id,
        code: "SENDER_PROFILE_LAUNCH_FAILED",
      });
      await updateSenderAccountRecord(owned.id, {
        status: "ERROR",
        lastError: error.message,
      });
      throw new BadRequestError("SENDER_PROFILE_LAUNCH_FAILED", error.message, {
        cause: error,
      });
    }
    // Browser/session launch failure is an ERROR, never AUTH_REQUIRED.
    const message =
      error instanceof SenderBrowserLaunchError
        ? error.message
        : "Could not inspect the Instagram browser session.";
    logger.warn("[SENDER VERIFY] browser launch failed", {
      senderAccountId: owned.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await updateSenderAccountRecord(owned.id, {
      status: "ERROR",
      lastError: message,
    });
    throw new BadRequestError("BROWSER_ERROR", message, { cause: error });
  }

  if (probe.authenticated) {
    const detectedUsername =
      probe.username && INSTAGRAM_USERNAME_PATTERN.test(probe.username)
        ? probe.username
        : null;

    // Resolve any duplicate-username row for this user before updating.
    if (detectedUsername && detectedUsername !== owned.username) {
      const duplicate = await findSenderByUsername(userId, detectedUsername);
      if (duplicate && duplicate.id !== owned.id) {
        await manager
          .closeSession(duplicate.id, "duplicate-sender-cleanup")
          .catch(() => undefined);
        removeSenderSessionDir(duplicate.sessionPath);
        await deleteSenderAccountRecord(duplicate.id);
      }
    }

    const verified = await updateSenderAccountRecord(owned.id, {
      status: "CONNECTED",
      username: detectedUsername ?? owned.username,
      lastVerifiedAt: new Date(),
      lastError: null,
    });

    // For interactive sessions the profile directory already persists the
    // session; closing the browser here frees resources. On a challenge we keep
    // it open (handled below) so the user can complete the challenge.
    if (manager.getInteractiveSession(owned.id)) {
      await manager.closeSession(owned.id, "verify-complete");
    }

    logger.info("[SENDER] account connected", {
      senderAccountId: verified.id,
      username: verified.username,
    });
    logger.info("[SENDER] session verified", { senderAccountId: verified.id });

    return toSenderAccountDto(verified);
  }

  const nowStatus: InstagramSenderStatus =
    probe.code === "SESSION_UNAVAILABLE"
      ? owned.lastVerifiedAt
        ? "EXPIRED"
        : "AUTH_REQUIRED"
      : probe.code === "CHALLENGE_DETECTED"
        ? "AUTH_REQUIRED"
        : probe.code === "BROWSER_ERROR"
          ? "ERROR"
          : "AUTH_REQUIRED";

  const updated = await updateSenderAccountRecord(owned.id, {
    status: nowStatus,
    lastError: probe.reason,
  });

  if (owned.status !== nowStatus) {
    await notifySenderStatusChange({
      userId: owned.userId,
      senderUsername: owned.username,
      previousStatus: owned.status,
      newStatus: nowStatus,
      errorMessage: probe.reason,
    }).catch(() => undefined);
  }

  logger.warn("[SENDER] authentication required", {
    senderAccountId: updated.id,
    status: nowStatus,
  });

  return toSenderAccountDto(updated);
}

export async function disconnectSenderAccount(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountDto> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }

  const manager = getSenderSessionManager();
  await manager.closeSession(owned.id, "disconnect").catch(() => undefined);
  removeSenderSessionDir(owned.sessionPath);

  const disconnected = await updateSenderAccountRecord(owned.id, {
    status: "DISCONNECTED",
    lastError: null,
    lastVerifiedAt: null,
  });

  logger.info("[SENDER] account disconnected", { senderAccountId: disconnected.id });

  return toSenderAccountDto(disconnected);
}

// ---------------------------------------------------------------------------
// Dispatch-time resolution (used by the message dispatcher / bulk worker)
// ---------------------------------------------------------------------------

export type SenderDispatchResolution =
  | { kind: "none" }
  | { kind: "ready"; sender: SenderAccountRecord }
  | {
      kind: "not_ready";
      sender: SenderAccountRecord | null;
      code: "AUTH_REQUIRED" | "SESSION_UNAVAILABLE";
      reason: string;
    };

/**
 * Resolves the sender account for a dispatch without ever trusting client
 * ownership:
 * - explicit senderAccountId is loaded and must belong to `userId`;
 * - otherwise the user's single CONNECTED account is used when one exists.
 */
export async function resolveSenderForDispatch(
  senderAccountId: string | null,
  userId: string,
): Promise<SenderDispatchResolution> {
  if (senderAccountId) {
    const owned = await findSenderAccountOwned(senderAccountId, userId);
    if (!owned) {
      throw new NotFoundError(
        "SENDER_NOT_FOUND",
        `Instagram sender account "${senderAccountId}" was not found.`,
      );
    }
    if (owned.status !== "CONNECTED") {
      return {
        kind: "not_ready",
        sender: owned,
        code:
          owned.status === "AUTH_REQUIRED" || owned.status === "EXPIRED"
            ? "AUTH_REQUIRED"
            : "SESSION_UNAVAILABLE",
        reason: `Instagram sender @${owned.username} is not connected (status: ${owned.status}).`,
      };
    }
    return { kind: "ready", sender: owned };
  }

  const total = await countSenderAccountsForUser(userId);
  if (total === 0) {
    // No sender accounts configured: fall back to legacy behavior.
    return { kind: "none" };
  }

  const connected = await findConnectedSenderForUser(userId);
  if (connected) {
    return { kind: "ready", sender: connected };
  }

  return {
    kind: "not_ready",
    sender: null,
    code: "SESSION_UNAVAILABLE",
    reason:
      "No connected Instagram sender account. Connect and verify an Instagram account first.",
  };
}

export type SenderDmDiagnostics = {
  senderAccountId: string;
  targetProfileUrl: string;
  recipientUsername: string | null;
  authenticated: boolean;
  reachableConversation: boolean;
  composerFound: boolean;
  code: string | null;
  message: string | null;
  diagnostics: DmSendDiagnostics;
};

/** Only instagram.com targets are allowed (no arbitrary navigation). */
function resolveDiagnosticTarget(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BadRequestError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const record = input as Record<string, unknown>;

  let rawUrl: string | null = null;
  if (typeof record.profileUrl === "string" && record.profileUrl.trim().length > 0) {
    rawUrl = record.profileUrl.trim();
  } else if (typeof record.username === "string" && record.username.trim().length > 0) {
    const username = record.username.trim().replace(/^@/, "");
    if (!INSTAGRAM_USERNAME_PATTERN.test(username)) {
      throw new BadRequestError(
        "INVALID_USERNAME",
        '"username" must be a valid Instagram handle.',
      );
    }
    rawUrl = `https://www.instagram.com/${username}/`;
  }

  if (!rawUrl) {
    throw new BadRequestError(
      "MISSING_TARGET",
      'Provide either "profileUrl" or "username".',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("INVALID_URL", '"profileUrl" must be a valid URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) {
    throw new BadRequestError(
      "INVALID_TARGET_HOST",
      "Only instagram.com profile targets are allowed.",
    );
  }

  return parsed.toString();
}

/**
 * Read-only, owner-scoped DM composer diagnostic. Opens the target profile in
 * the sender's persistent session and reports whether the conversation and
 * composer were detected. NEVER types or sends a message.
 */
export async function diagnoseSenderDm(
  senderAccountId: string,
  userId: string,
  input: unknown,
): Promise<SenderDmDiagnostics> {
  const owned = await findSenderAccountOwned(senderAccountId, userId);
  if (!owned) {
    throw new NotFoundError(
      "SENDER_NOT_FOUND",
      `Instagram sender account "${senderAccountId}" was not found.`,
    );
  }
  const targetProfileUrl = resolveDiagnosticTarget(input);

  if (owned.status !== "CONNECTED") {
    throw new BadRequestError(
      owned.status === "AUTH_REQUIRED" || owned.status === "EXPIRED"
        ? "AUTH_REQUIRED"
        : "SESSION_UNAVAILABLE",
      `Instagram sender @${owned.username} is not connected (status: ${owned.status}).`,
    );
  }

  const isUnipile =
    owned.connectionMethod === "UNIPILE" ||
    Boolean(owned.unipileAccountId) ||
    owned.sessionPath.startsWith("unipile:") ||
    getServerEnv("MESSAGING_PROVIDER")?.toLowerCase() === "unipile";
  if (isUnipile) {
    const unipile = getUnipileClient();
    const cleanUsername = UnipileClient.extractUsername(targetProfileUrl);
    const unipileAccId =
      owned.unipileAccountId ||
      (owned.sessionPath.startsWith("unipile:")
        ? owned.sessionPath.replace(/^unipile:/, "")
        : undefined);

    const userProfile = await unipile.resolveInstagramUser(cleanUsername, unipileAccId);
    const reachable = Boolean(userProfile);

    return {
      senderAccountId: owned.id,
      targetProfileUrl: safeDmUrl(targetProfileUrl),
      recipientUsername: cleanUsername,
      authenticated: true,
      reachableConversation: reachable,
      composerFound: reachable,
      code: reachable ? null : "RECIPIENT_NOT_FOUND",
      message: reachable
        ? null
        : "User was not found or is private/unreachable on Instagram via Unipile.",
      diagnostics: {
        profileUrl: safeDmUrl(targetProfileUrl),
        recipientUsername: cleanUsername,
        currentUrl: targetProfileUrl,
        pageTitle: `Instagram DM (${reachable ? "Reachable" : "Not Found"})`,
        authenticated: true,
        pagesCount: 1,
        navigationSucceeded: true,
        pageState: reachable ? "READY" : "RECIPIENT_NOT_FOUND",
        classificationSource: "instagram-dm",
        restrictionUiDetected: false,
        conversationUiDetected: reachable,
        messageActionFound: reachable ? "Unipile Chat API" : null,
        composerFound: reachable ? "Unipile Message Gateway" : null,
        composerCandidates: [],
        messageActionCandidates: [],
      },
    };
  }

  const manager = getSenderSessionManager();

  const session = await manager.getSession(owned.id);

  try {
    const probe = await session.probeAuth();
    if (!probe.authenticated) {
      return {
        senderAccountId: owned.id,
        targetProfileUrl: safeDmUrl(targetProfileUrl),
        recipientUsername: null,
        authenticated: false,
        reachableConversation: false,
        composerFound: false,
        code: probe.code === "CHALLENGE_DETECTED" ? "CAPTCHA_REQUIRED" : "AUTH_REQUIRED",
        message: probe.reason,
        diagnostics: {
          profileUrl: safeDmUrl(targetProfileUrl),
          recipientUsername: null,
          currentUrl: safeDmUrl(session.context.pages()[0]?.url() ?? ""),
          pageTitle: "",
          authenticated: false,
          pagesCount: session.context.pages().length,
          navigationSucceeded: false,
          pageState: "AUTH_REQUIRED",
          classificationSource: "instagram-dm",
          restrictionUiDetected: false,
          conversationUiDetected: false,
          messageActionFound: null,
          composerFound: null,
          composerCandidates: [],
          messageActionCandidates: [],
        },
      };
    }

    const page = session.context.pages()[0] ?? (await session.context.newPage());
    const inspection = await inspectInstagramDmTarget({
      page,
      profileUrl: targetProfileUrl,
      authenticated: true,
      onDiagnostic: (diagnostics) => {
        logger.info("[SENDER DM DIAGNOSTICS]", {
          senderAccountId: owned.id,
          currentUrl: diagnostics.currentUrl,
          pageState: diagnostics.pageState,
          messageActionFound: diagnostics.messageActionFound,
          composerFound: diagnostics.composerFound,
          composerCandidates: diagnostics.composerCandidates,
        });
      },
    });

    return {
      senderAccountId: owned.id,
      targetProfileUrl: safeDmUrl(targetProfileUrl),
      recipientUsername: inspection.diagnostics.recipientUsername,
      authenticated: true,
      reachableConversation: inspection.diagnostics.conversationUiDetected,
      composerFound: inspection.ok,
      code: inspection.ok ? null : inspection.code,
      message: inspection.ok ? null : inspection.message,
      diagnostics: inspection.diagnostics,
    };
  } finally {
    manager.release(owned.id);
  }
}

export async function findConnectedSenderForDispatch(
  userId: string,
): Promise<SenderAccountRecord | null> {
  return findConnectedSenderForUser(userId);
}
