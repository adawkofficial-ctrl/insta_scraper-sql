import "server-only";

import { getUnipileConfig, type UnipileConfig } from "@/lib/env";
import { logger } from "@/lib/logger";

export type UnipileAccountSource = {
  id?: string;
  status?: "OK" | "CONNECTING" | "CREDENTIALS" | "STOPPED" | "ERROR" | string;
  [key: string]: unknown;
};

export type UnipileAccount = {
  id: string;
  type?: string;
  provider?: string;
  name?: string;
  status?: "OK" | "CONNECTING" | "CREDENTIALS" | "STOPPED" | "ERROR" | string;
  sources?: UnipileAccountSource[];
  connection_params?: {
    im?: {
      id?: string;
      username?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  created_at?: string;
  [key: string]: unknown;
};

export function isUnipileAccountActive(acc: UnipileAccount): boolean {
  if (
    typeof acc.status === "string" &&
    (acc.status.toUpperCase() === "OK" || acc.status.toUpperCase() === "CONNECTED")
  ) {
    return true;
  }
  if (Array.isArray(acc.sources) && acc.sources.length > 0) {
    return acc.sources.some(
      (s) =>
        typeof s?.status === "string" &&
        (s.status.toUpperCase() === "OK" || s.status.toUpperCase() === "CONNECTED"),
    );
  }
  return false;
}

export function getUnipileAccountUsername(acc: UnipileAccount): string | null {
  if (typeof acc.name === "string" && acc.name.trim()) {
    return acc.name.trim();
  }
  const imUsername = acc.connection_params?.im?.username;
  if (typeof imUsername === "string" && imUsername.trim()) {
    return imUsername.trim();
  }
  const rawUsername = (acc as Record<string, unknown>).username;
  if (typeof rawUsername === "string" && rawUsername.trim()) {
    return rawUsername.trim();
  }
  return null;
}

export type UnipileAccountsResponse = {
  items: UnipileAccount[];
  cursor?: string | null;
  total_count?: number;
  status_counts?: Record<string, number>;
};

export type UnipileUserResponse = {
  id: string;
  provider_id?: string;
  provider_messaging_id?: string;
  name?: string;
  username?: string;
  public_identifier?: string;
  [key: string]: unknown;
};

export type UnipileHostedLinkOptions = {
  type?: "create" | "reconnect";
  existingAccountId?: string;
  providers?: string[];
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
  notifyUrl?: string;
  name?: string;
};

export type UnipileSendMessageParams = {
  accountId: string;
  recipientProviderId: string;
  text: string;
};

export type UnipileSendChatMessageParams = {
  chatId: string;
  text: string;
};

export type UnipileSendMessageResult =
  | { success: true; messageId: string; raw: unknown }
  | { success: false; code: string; message: string };

export class UnipileClient {
  private config: UnipileConfig;

  constructor(customConfig?: Partial<UnipileConfig>) {
    const base = getUnipileConfig();
    this.config = {
      apiKey: customConfig?.apiKey ?? base.apiKey,
      dsn: customConfig?.dsn ?? base.dsn,
      baseUrl: customConfig?.baseUrl ?? base.baseUrl,
      isConfigured: customConfig?.apiKey !== undefined ? Boolean(customConfig.apiKey) : base.isConfigured,
    };
  }

  get isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.baseUrl);
  }

  private get headers(): Record<string, string> {
    return {
      "X-API-KEY": this.config.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /**
   * Cleans and extracts an Instagram username from a profile URL or raw username.
   */
  static extractUsername(profileUrlOrUsername: string): string {
    const trimmed = profileUrlOrUsername.trim();
    if (!trimmed) return "";

    const withoutProtocol = trimmed.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "");
    const parts = withoutProtocol.split(/[\/?#]/);
    const candidate = parts[0]?.replace(/^@/, "").trim() || "";
    return candidate;
  }

  /**
   * Retrieves all accounts linked to the Unipile instance.
   */
  async getAccounts(): Promise<UnipileAccount[]> {
    if (!this.isConfigured) {
      return [];
    }

    const url = `${this.config.baseUrl}/accounts`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.headers,
        next: { revalidate: 0 },
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        logger.error("[UNIPILE] failed to fetch accounts", {
          status: res.status,
          response: errorText,
        });
        return [];
      }

      const data = (await res.json()) as UnipileAccountsResponse | UnipileAccount[];
      if (Array.isArray(data)) {
        return data;
      }
      return data.items || [];
    } catch (err) {
      logger.error("[UNIPILE] network error fetching accounts", err as Error);
      return [];
    }
  }

  /**
   * Retrieves single account by ID.
   */
  async getAccount(accountId: string): Promise<UnipileAccount | null> {
    if (!this.isConfigured || !accountId) return null;

    const url = `${this.config.baseUrl}/accounts/${encodeURIComponent(accountId)}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.headers,
        next: { revalidate: 0 },
      });

      if (!res.ok) return null;
      return (await res.json()) as UnipileAccount;
    } catch {
      return null;
    }
  }

  /**
   * Connects an Instagram account using session cookies (bypasses Instagram datacenter IP blocks).
   */
  async connectWithSessionId(
    sessionId: string,
    userAgent?: string,
  ): Promise<{ success: true; accountId: string } | { success: false; message: string }> {
    if (!this.isConfigured) {
      return {
        success: false,
        message: "Unipile is not configured with valid credentials in .env.",
      };
    }

    const cleanSessionId = sessionId.trim().replace(/^sessionid=/i, "");
    const url = `${this.config.baseUrl}/accounts`;
    const payload: Record<string, unknown> = {
      provider: "INSTAGRAM",
      sessionid: cleanSessionId,
    };

    if (userAgent && userAgent.trim()) {
      payload.user_agent = userAgent.trim();
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      const responseText = await res.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = { raw: responseText };
      }

      if (!res.ok) {
        const errorDetail =
          (typeof parsed.detail === "string" ? parsed.detail : undefined) ??
          (typeof parsed.message === "string" ? parsed.message : undefined) ??
          (typeof parsed.title === "string" ? parsed.title : undefined) ??
          `Unipile returned status ${res.status}`;

        logger.error("[UNIPILE] failed to connect with sessionid", {
          status: res.status,
          error: errorDetail,
        });

        return {
          success: false,
          message: `Instagram cookie authentication failed: ${errorDetail}`,
        };
      }

      const accountId =
        (typeof parsed.account_id === "string" ? parsed.account_id : undefined) ??
        (typeof parsed.id === "string" ? parsed.id : undefined);

      if (!accountId) {
        return {
          success: false,
          message: "Unipile did not return an account ID after cookie authentication.",
        };
      }

      return {
        success: true,
        accountId,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Network error connecting to Unipile: ${errorMsg}`,
      };
    }
  }

  /**
   * Generates a Hosted Auth Link so users can securely authenticate their Instagram account.
   */

  async createHostedAuthLink(options: UnipileHostedLinkOptions = {}): Promise<{ url: string } | null> {
    if (!this.isConfigured) {
      throw new Error("Unipile is not configured. Missing UNIPILE_API_KEY or UNIPILE_DSN.");
    }

    const url = `${this.config.baseUrl}/hosted/accounts/link`;
    const payload: Record<string, unknown> = {
      type: options.type ?? "create",
      providers: options.providers ?? ["INSTAGRAM"],
      api_url: this.config.baseUrl.replace(/\/api\/v1\/?$/, ""),
      expiresOn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    if (options.existingAccountId) {
      payload.account_id = options.existingAccountId;
    }
    if (options.successRedirectUrl) {
      payload.success_redirect_url = options.successRedirectUrl;
    }
    if (options.failureRedirectUrl) {
      payload.failure_redirect_url = options.failureRedirectUrl;
    }
    if (options.notifyUrl) {
      payload.notify_url = options.notifyUrl;
    }
    if (options.name) {
      payload.name = options.name;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        logger.error("[UNIPILE] failed to generate hosted auth link", {
          status: res.status,
          response: errorText,
        });
        throw new Error(`Unipile hosted link generation failed (${res.status}): ${errorText}`);
      }

      const data = (await res.json()) as { url?: string };
      if (!data.url) {
        throw new Error("Unipile returned no hosted auth URL in response.");
      }

      return { url: data.url };
    } catch (err) {
      logger.error("[UNIPILE] error generating hosted link", err as Error);
      throw err;
    }
  }

  /**
   * Resolves an Instagram username to the provider's internal ID needed for messaging.
   */
  async resolveInstagramUser(
    username: string,
    accountId?: string,
  ): Promise<UnipileUserResponse | null> {
    if (!this.isConfigured) return null;

    const cleanUsername = UnipileClient.extractUsername(username);
    if (!cleanUsername) return null;

    const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
    const url = `${this.config.baseUrl}/users/${encodeURIComponent(cleanUsername)}${query}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.headers,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logger.warn("[UNIPILE] could not resolve Instagram user", {
          username: cleanUsername,
          status: res.status,
          error: errText,
        });
        return null;
      }

      return (await res.json()) as UnipileUserResponse;
    } catch (err) {
      logger.error("[UNIPILE] error resolving user", err as Error, { username: cleanUsername });
      return null;
    }
  }

  /**
   * Sends a direct message to an Instagram recipient via Unipile.
   */
  async sendDirectMessage(
    params: UnipileSendMessageParams,
  ): Promise<UnipileSendMessageResult> {
    if (!this.isConfigured) {
      return {
        success: false,
        code: "AUTH_REQUIRED",
        message: "Unipile is not configured with valid credentials in .env.",
      };
    }

    const { accountId, recipientProviderId, text } = params;

    const url = `${this.config.baseUrl}/chats`;
    const payload = {
      account_id: accountId,
      attendees_ids: [recipientProviderId],
      text: text.trim(),
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      const responseBody = await res.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = { raw: responseBody };
      }

      if (!res.ok) {
        const errCode = this.classifyErrorCode(res.status, parsed);
        return {
          success: false,
          code: errCode,
          message:
            typeof parsed.message === "string"
              ? parsed.message
              : `Unipile API returned error status ${res.status}`,
        };
      }

      // Check if message ID is returned in chat response
      const messageId =
        (typeof parsed.id === "string" ? parsed.id : undefined) ??
        (typeof parsed.message_id === "string" ? parsed.message_id : undefined) ??
        (typeof (parsed.message as Record<string, unknown>)?.id === "string"
          ? ((parsed.message as Record<string, unknown>).id as string)
          : `unipile_msg_${Date.now()}`);

      return {
        success: true,
        messageId,
        raw: parsed,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        code: "NETWORK_ERROR",
        message: `Network error contacting Unipile API: ${errorMsg}`,
      };
    }
  }

  /**
   * Sends a message directly into an existing Unipile chat thread.
   */
  async sendChatMessage(
    params: UnipileSendChatMessageParams,
  ): Promise<UnipileSendMessageResult> {
    if (!this.isConfigured) {
      return {
        success: false,
        code: "AUTH_REQUIRED",
        message: "Unipile is not configured with valid credentials in .env.",
      };
    }

    const { chatId, text } = params;
    const url = `${this.config.baseUrl}/chats/${encodeURIComponent(chatId)}/messages`;
    const payload = {
      text: text.trim(),
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      const responseBody = await res.text().catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = { raw: responseBody };
      }

      if (!res.ok) {
        const errCode = this.classifyErrorCode(res.status, parsed);
        return {
          success: false,
          code: errCode,
          message:
            typeof parsed.message === "string"
              ? parsed.message
              : `Unipile API returned error status ${res.status}`,
        };
      }

      const messageId =
        (typeof parsed.id === "string" ? parsed.id : undefined) ??
        (typeof parsed.message_id === "string" ? parsed.message_id : undefined) ??
        (typeof (parsed.message as Record<string, unknown>)?.id === "string"
          ? ((parsed.message as Record<string, unknown>).id as string)
          : `unipile_msg_${Date.now()}`);

      return {
        success: true,
        messageId,
        raw: parsed,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        code: "NETWORK_ERROR",
        message: `Network error contacting Unipile API: ${errorMsg}`,
      };
    }
  }

  private classifyErrorCode(status: number, errorData: Record<string, unknown>): string {
    const msg = (typeof errorData.message === "string" ? errorData.message : "").toUpperCase();

    if (status === 401 || status === 403 || msg.includes("AUTH") || msg.includes("CREDENTIAL")) {
      return "AUTH_REQUIRED";
    }
    if (status === 429 || msg.includes("RATE") || msg.includes("LIMIT")) {
      return "RATE_LIMITED";
    }
    if (status === 404 || msg.includes("USER_NOT_FOUND") || msg.includes("RECIPIENT")) {
      return "RECIPIENT_NOT_FOUND";
    }
    if (msg.includes("CHALLENGE") || msg.includes("CAPTCHA")) {
      return "CAPTCHA_REQUIRED";
    }
    if (msg.includes("RESTRICT") || msg.includes("SUSPEND") || msg.includes("BLOCK")) {
      return "ACCOUNT_RESTRICTED";
    }
    return "API_ERROR";
  }
}

let defaultUnipileClient: UnipileClient | null = null;

export function getUnipileClient(): UnipileClient {
  if (!defaultUnipileClient) {
    defaultUnipileClient = new UnipileClient();
  }
  return defaultUnipileClient;
}
