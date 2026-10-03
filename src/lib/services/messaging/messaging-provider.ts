export type ProviderStatus = "READY" | "AUTH_REQUIRED" | "ERROR";

export type MessagingProviderStatus = {
  provider: string;
  authenticated: boolean;
  status: ProviderStatus;
  message?: string;
};

export type SendMessageRequest = {
  profileUrl: string;
  message: string;
  /**
   * Authoritative Instagram sender account. When present, dispatch uses that
   * account's dedicated Playwright session. When absent the legacy global
   * browser profile is used.
   */
  senderAccountId?: string;
  /**
   * Existing chat/thread identifier (e.g. Unipile chat_id).
   * When provided, provider sends directly into this existing thread.
   */
  chatId?: string;
};

export type SendMessageResult = {
  success: boolean;
  provider: string;
  messageText: string;
  providerMessageId?: string;
  sentAt?: string;
  error?: {
    code: string;
    message: string;
  };
};


export interface MessagingProvider {
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<MessagingProviderStatus>;
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
}
