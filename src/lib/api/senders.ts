import { apiFetch } from "./client";

export type InstagramSenderStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "ACTIVE"
  | "WARMING"
  | "PAUSED"
  | "NEEDS_ATTENTION"
  | "AUTH_REQUIRED"
  | "EXPIRED"
  | "ERROR"
  | "DISCONNECTED";

export type InstagramSenderSessionType = "PERSISTENT_PROFILE" | "STORAGE_STATE";

export type SenderSessionDiagnostics = {
  live: boolean;
  mode: "manual-login" | "headless";
  headed: boolean;
  browserName: string | null;
  browserVersion: string | null;
  pagesCount: number;
  currentUrl: string | null;
  isClosed: boolean;
  pageClosed: boolean;
  viewport: { width: number; height: number } | null;
};

export type ConnectionMethod = "PLAYWRIGHT" | "UNIPILE";

export type InstagramSenderAccount = {
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
  sessionDiagnostics: SenderSessionDiagnostics | null;
  sentToday: number;
  sentThisHour: number;
  totalSent: number;
  dailyCap: number | null;
  effectiveDailyCap: number;
  hourlyCap: number | null;
  effectiveHourlyCap: number;
  warmupStage: string;
  warmupStartedAt: string | null;
  pausedUntil: string | null;
  lastSentAt: string | null;
  lastErrorCode: string | null;
  consecutiveErrors: number;
  customMinGapSeconds: number | null;
  customMaxGapSeconds: number | null;
  timezone: string;
  workingHoursStart: number;
  workingHoursEnd: number;
  nextAllowedSendAt?: string | null;
};

export type ConnectSenderResponse = {
  success: true;
  status: "CONNECTING" | "CONNECTED";
  reusedExistingSession: boolean;
  sender: InstagramSenderAccount;
  instructions: string;
  connectUrl?: string;
};


export type DmCandidateDiagnostic = {
  description: string;
  count: number;
  visible: boolean;
  editable: boolean;
};

export type SenderDmDiagnostics = {
  senderAccountId: string;
  targetProfileUrl: string;
  recipientUsername: string | null;
  authenticated: boolean;
  reachableConversation: boolean;
  composerFound: boolean;
  code: string | null;
  message: string | null;
  diagnostics: {
    currentUrl: string;
    pageTitle: string;
    pageState: string;
    conversationUiDetected: boolean;
    messageActionFound: string | null;
    composerFound: string | null;
    composerCandidates: DmCandidateDiagnostic[];
    messageActionCandidates: DmCandidateDiagnostic[];
  };
};

/**
 * Read-only DM composer diagnostic. Never types or sends a message — safe to
 * run against a real connected sender.
 */
export async function diagnoseSenderDm(
  senderAccountId: string,
  input: { profileUrl?: string; username?: string },
): Promise<SenderDmDiagnostics> {
  const data = await apiFetch<{ diagnostics: SenderDmDiagnostics }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/diagnose-dm`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.diagnostics;
}

export async function listSenderAccounts(): Promise<InstagramSenderAccount[]> {
  const data = await apiFetch<{ senders: InstagramSenderAccount[] }>(
    "/api/instagram/senders",
  );
  return data.senders;
}

export async function createSenderAccount(input: {
  username?: string;
  displayName?: string;
}): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    "/api/instagram/senders",
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.sender;
}

export async function connectSenderAccount(
  senderAccountId: string,
  options?: { sessionId?: string; userAgent?: string },
): Promise<ConnectSenderResponse> {
  return apiFetch<ConnectSenderResponse>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/connect`,
    {
      method: "POST",
      ...(options ? { body: JSON.stringify(options) } : {}),
    },
  );
}


export async function verifySenderAccount(
  senderAccountId: string,
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/verify`,
    { method: "POST" },
  );
  return data.sender;
}

export async function cancelSenderLogin(
  senderAccountId: string,
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/cancel`,
    { method: "POST" },
  );
  return data.sender;
}

export async function disconnectSenderAccount(
  senderAccountId: string,
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/disconnect`,
    { method: "POST" },
  );
  return data.sender;
}

export async function deleteSenderAccount(
  senderAccountId: string,
): Promise<{ success: true; id: string }> {
  return apiFetch<{ success: true; id: string }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}`,
    { method: "DELETE" },
  );
}

export async function updateSenderSettings(
  senderAccountId: string,
  settings: {
    dailyCap?: number | null;
    hourlyCap?: number | null;
    customMinGapSeconds?: number | null;
    customMaxGapSeconds?: number | null;
    timezone?: string;
    workingHoursStart?: number;
    workingHoursEnd?: number;
  },
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}`,
    { method: "PATCH", body: JSON.stringify(settings) },
  );
  return data.sender;
}

export async function pauseSenderAccount(
  senderAccountId: string,
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/pause`,
    { method: "POST" },
  );
  return data.sender;
}

export async function resumeSenderAccount(
  senderAccountId: string,
): Promise<InstagramSenderAccount> {
  const data = await apiFetch<{ sender: InstagramSenderAccount }>(
    `/api/instagram/senders/${encodeURIComponent(senderAccountId)}/resume`,
    { method: "POST" },
  );
  return data.sender;
}
