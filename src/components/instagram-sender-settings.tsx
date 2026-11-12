"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cancelSenderLogin,
  connectSenderAccount,
  createSenderAccount,
  deleteSenderAccount,
  diagnoseSenderDm,
  disconnectSenderAccount,
  listSenderAccounts,
  verifySenderAccount,
  pauseSenderAccount,
  resumeSenderAccount,
  updateSenderSettings,
  type InstagramSenderAccount,
  type SenderDmDiagnostics,
  type SenderSessionDiagnostics,
} from "@/lib/api/senders";
import { ApiClientError } from "@/lib/api/client";

const CONNECTING_POLL_MS = 1500;

function getStatusBadge(status: InstagramSenderAccount["status"]) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border";
  switch (status) {
    case "ACTIVE":
    case "CONNECTED":
      return (
        <span className={`${base} border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
          {status === "ACTIVE" ? "Active" : "Connected"}
        </span>
      );
    case "WARMING":
      return (
        <span className={`${base} border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 shrink-0" />
          Warming Up
        </span>
      );
    case "PAUSED":
      return (
        <span className={`${base} border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          Paused
        </span>
      );
    case "NEEDS_ATTENTION":
      return (
        <span className={`${base} border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse shrink-0" />
          Needs Attention
        </span>
      );
    case "CONNECTING":
      return (
        <span className={`${base} border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
          Connecting
        </span>
      );
    case "AUTH_REQUIRED":
    case "EXPIRED":
      return (
        <span className={`${base} border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
          Authentication Required
        </span>
      );
    case "ERROR":
      return (
        <span className={`${base} border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
          Error
        </span>
      );
    default:
      return (
        <span className={`${base} border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 shrink-0" />
          Disconnected
        </span>
      );
  }
}

function elapsedLabel(fromIso: string, nowMs: number): string {
  const started = new Date(fromIso).getTime();
  if (!Number.isFinite(started)) return "0s";
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function SenderDiagnosticsPanel({
  diagnostics,
  status,
}: {
  diagnostics: SenderSessionDiagnostics | null;
  status: InstagramSenderAccount["status"];
}) {
  const live = diagnostics?.live === true;
  return (
    <dl
      data-testid="sender-diagnostics"
      className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 rounded-xl border border-subtle bg-surface p-3 text-[11px] text-muted sm:grid-cols-2"
    >
      <div>
        <dt className="inline text-muted">Service: </dt>
        <dd className="inline font-medium text-secondary">
          {diagnostics?.browserName ?? "Unipile API"}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Mode: </dt>
        <dd className="inline font-medium text-secondary">
          {diagnostics?.mode === "manual-login" || status === "CONNECTING"
            ? "Hosted Authentication"
            : (diagnostics?.mode ?? "Unipile Gateway")}
        </dd>
      </div>

      <div>
        <dt className="inline text-muted">Headed: </dt>
        <dd className="inline font-medium text-secondary">
          {String(diagnostics?.headed ?? status === "CONNECTING")}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Status: </dt>
        <dd className="inline font-medium text-secondary">{status}</dd>
      </div>
      <div>
        <dt className="inline text-muted">Pages: </dt>
        <dd className="inline font-medium text-secondary">
          {live ? diagnostics?.pagesCount : "-"}
        </dd>
      </div>
      <div>
        <dt className="inline text-muted">Current URL: </dt>
        <dd className="inline font-medium text-secondary">
          {live && diagnostics?.currentUrl ? diagnostics.currentUrl : "-"}
        </dd>
      </div>
    </dl>
  );
}

export function InstagramSenderSettings() {
  const [senders, setSenders] = useState<InstagramSenderAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [showCookieModal, setShowCookieModal] = useState(false);
  const [cookieInput, setCookieInput] = useState("");
  const [isConnectingCookie, setIsConnectingCookie] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dmTarget, setDmTarget] = useState("");
  const [dmResult, setDmResult] = useState<SenderDmDiagnostics | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const list = await listSenderAccounts();
      setSenders(list);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not load Instagram sender accounts.",
      );
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) void refresh();
    });
    return () => {
      ignore = true;
    };
  }, [refresh]);

  const connectingSender = senders.find((s) => s.status === "CONNECTING") ?? null;
  const hasConnecting = connectingSender !== null;

  // Poll while any sender is CONNECTING; stops automatically on terminal status.
  useEffect(() => {
    if (!hasConnecting) return;
    const timer = setInterval(() => {
      void refresh({ silent: true });
    }, CONNECTING_POLL_MS);
    return () => clearInterval(timer);
  }, [hasConnecting, refresh]);

  // Auto-refresh when user returns to this browser tab (e.g. after completing Unipile auth)
  useEffect(() => {
    const handleFocus = () => {
      void refresh({ silent: true });
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  // Live elapsed timer for the connecting panel.
  useEffect(() => {
    if (!hasConnecting) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasConnecting]);

  const describeError = (err: unknown, fallback: string): string =>
    err instanceof ApiClientError ? err.message : fallback;

  const handleConnect = async () => {
    if (connectingSender) return;
    setIsCreating(true);
    setError(null);
    setNotice(null);
    try {
      const reusable = senders.find(
        (sender) => sender.status !== "CONNECTED" && sender.status !== "CONNECTING",
      );
      const sender = reusable ?? (await createSenderAccount({}));
      const res = await connectSenderAccount(sender.id);
      setNotice(res.instructions);
      if (res.connectUrl) {
        setConnectUrl(res.connectUrl);
        window.open(res.connectUrl, "_blank", "noopener,noreferrer");
      }
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not initiate Instagram connection."));
    } finally {
      setIsCreating(false);
    }
  };

  const handleConnectSender = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      const res = await connectSenderAccount(sender.id);
      setNotice(res.instructions);
      if (res.connectUrl) {
        setConnectUrl(res.connectUrl);
        window.open(res.connectUrl, "_blank", "noopener,noreferrer");
      }
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not initiate Instagram connection."));
    } finally {
      setBusyId(null);
    }
  };

  const handleConnectWithCookie = async (targetSenderId?: string) => {
    const rawCookie = cookieInput.trim();
    if (!rawCookie) {
      setError("Please paste your Instagram sessionid cookie.");
      return;
    }
    setIsConnectingCookie(true);
    setError(null);
    setNotice(null);
    try {
      let senderId = targetSenderId;
      if (!senderId) {
        const reusable = senders.find(
          (sender) => sender.status !== "CONNECTED" && sender.status !== "CONNECTING",
        );
        const sender = reusable ?? (await createSenderAccount({}));
        senderId = sender.id;
      }

      const res = await connectSenderAccount(senderId, {
        sessionId: rawCookie,
      });

      setNotice(res.instructions);
      setCookieInput("");
      setShowCookieModal(false);
      await refresh({ silent: true });
    } catch (err) {
      setError(
        describeError(
          err,
          "Instagram cookie authentication failed. Please verify the sessionid is fresh and valid.",
        ),
      );
    } finally {
      setIsConnectingCookie(false);
    }
  };

  const handleVerify = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await verifySenderAccount(sender.id);
      if (updated.isConnected) {
        setNotice(`Connected as @${updated.username}.`);
      } else {
        setNotice(
          updated.lastError ||
            "Session is not authenticated yet. Complete the login in the browser, then verify again.",
        );
      }
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not verify the Instagram session."));
    } finally {
      setBusyId(null);
    }
  };

  const handleCancelLogin = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      await cancelSenderLogin(sender.id);
      setNotice("Login cancelled. Click Connect again when you are ready.");
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not cancel the Instagram login."));
    } finally {
      setBusyId(null);
    }
  };

  const handleDiagnoseDm = async (sender: InstagramSenderAccount) => {
    if (!dmTarget.trim()) return;
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    setDmResult(null);
    try {
      const result = await diagnoseSenderDm(sender.id, { username: dmTarget.trim() });
      setDmResult(result);
    } catch (err) {
      setError(describeError(err, "Could not run the DM composer diagnostic."));
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      await disconnectSenderAccount(sender.id);
      setNotice(`Disconnected @${sender.username}.`);
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not disconnect the Instagram account."));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteSender = async (sender: InstagramSenderAccount) => {
    const ok = window.confirm(
      `Are you sure you want to permanently delete @${sender.username}? This will remove the account from the database and UI.`
    );
    if (!ok) return;

    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      await deleteSenderAccount(sender.id);
      setSenders((prev) => prev.filter((s) => s.id !== sender.id));
      setNotice(`Deleted @${sender.username} from database.`);
    } catch (err) {
      setError(describeError(err, "Could not delete the Instagram sender account."));
    } finally {
      setBusyId(null);
    }
  };

  const handlePauseSender = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      await pauseSenderAccount(sender.id);
      setNotice(`Paused outbound sends for @${sender.username}.`);
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not pause sender account."));
    } finally {
      setBusyId(null);
    }
  };

  const handleResumeSender = async (sender: InstagramSenderAccount) => {
    setBusyId(sender.id);
    setError(null);
    setNotice(null);
    try {
      await resumeSenderAccount(sender.id);
      setNotice(`Resumed outbound sends for @${sender.username}.`);
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not resume sender account."));
    } finally {
      setBusyId(null);
    }
  };

  const [editingSenderId, setEditingSenderId] = useState<string | null>(null);
  const [editDailyCap, setEditDailyCap] = useState<number>(25);
  const [editHourlyCap, setEditHourlyCap] = useState<number>(6);
  const [editHoursStart, setEditHoursStart] = useState<number>(9);
  const [editHoursEnd, setEditHoursEnd] = useState<number>(18);
  const [editTimezone, setEditTimezone] = useState<string>("UTC");

  const handleStartEdit = (sender: InstagramSenderAccount) => {
    setEditingSenderId(sender.id);
    setEditDailyCap(sender.dailyCap ?? sender.effectiveDailyCap ?? 25);
    setEditHourlyCap(sender.hourlyCap ?? sender.effectiveHourlyCap ?? 6);
    setEditHoursStart(sender.workingHoursStart ?? 9);
    setEditHoursEnd(sender.workingHoursEnd ?? 18);
    setEditTimezone(sender.timezone ?? "UTC");
  };

  const handleSaveSettings = async (senderId: string) => {
    setBusyId(senderId);
    setError(null);
    setNotice(null);
    try {
      await updateSenderSettings(senderId, {
        dailyCap: Number(editDailyCap),
        hourlyCap: Number(editHourlyCap),
        workingHoursStart: Number(editHoursStart),
        workingHoursEnd: Number(editHoursEnd),
        timezone: editTimezone.trim() || "UTC",
      });
      setEditingSenderId(null);
      setNotice("Safety limits updated successfully.");
      await refresh({ silent: true });
    } catch (err) {
      setError(describeError(err, "Could not update sender safety settings."));
    } finally {
      setBusyId(null);
    }
  };

  const connectedCount = senders.filter((s) => s.isConnected).length;
  const overallStatus = connectedCount > 0
    ? `${connectedCount} Connected Account${connectedCount > 1 ? "s" : ""}`
    : hasConnecting
      ? "Connecting"
      : "Not Connected";

  return (
    <section className="rounded-2xl border border-subtle bg-surface shadow-card p-6 transition-colors">
      <div className="flex flex-col gap-3 border-b border-subtle pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-primary">Instagram Sender Accounts</h2>
            {connectedCount > 1 && (
              <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                🔄 Round-Robin Enabled ({connectedCount} Accounts)
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted max-w-2xl">
            Connect up to 10+ Instagram accounts for campaign outreach. Messages automatically rotate across your
            connected accounts in round-robin sequence with an inter-message safety cooldown (default 10 minutes per account)
            to maximize delivery speed while protecting account trust.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          <button
            type="button"
            id="connect-with-cookie-toggle-btn"
            onClick={() => setShowCookieModal((prev) => !prev)}
            className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3.5 py-2 text-xs font-medium text-secondary hover:text-primary shadow-card transition-all cursor-pointer"
          >
            {showCookieModal ? "Close Cookie Login" : "Connect via Cookie"}
          </button>
          <button
            type="button"
            id="connect-instagram-account-btn"
            onClick={handleConnect}
            disabled={isCreating || busyId !== null || hasConnecting}
            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition-all disabled:opacity-40 cursor-pointer"
          >
            {hasConnecting
              ? "Connecting..."
              : isCreating
                ? "Generating link..."
                : connectedCount > 0
                  ? "+ Add Another Account"
                  : "Connect via Hosted Link"}
          </button>
        </div>
      </div>

      {showCookieModal && (
        <div className="mt-4 rounded-xl border border-indigo-500/30 bg-subtle p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-primary flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
              Connect via Instagram Session Cookie (sessionid)
            </h4>
            <button
              type="button"
              onClick={() => setShowCookieModal(false)}
              className="text-xs text-muted hover:text-primary cursor-pointer"
            >
              &times;
            </button>
          </div>
          <div className="rounded-lg border border-subtle bg-surface p-3 text-[11px] text-muted space-y-1.5">
            <p className="font-semibold text-primary">How to get your sessionid cookie (bypasses Instagram IP blocks):</p>
            <ol className="list-decimal pl-4 space-y-0.5 text-muted">
              <li>Open <a href="https://www.instagram.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 underline">instagram.com</a> in your browser where you are logged in.</li>
              <li>Press <kbd className="rounded bg-subtle border border-subtle px-1 py-0.5 text-primary">F12</kbd> (or right click &gt; Inspect).</li>
              <li>Go to <strong>Application</strong> tab (or Storage in Firefox) &gt; <strong>Cookies</strong> &gt; <strong>https://www.instagram.com</strong>.</li>
              <li>Find the cookie named <strong>sessionid</strong>, copy its value, and paste it below.</li>
            </ol>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              placeholder="Paste Instagram sessionid value here..."
              className="flex-1 rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors"
            />
            <button
              type="button"
              id="authenticate-cookie-btn"
              onClick={() => handleConnectWithCookie()}
              disabled={isConnectingCookie || !cookieInput.trim()}
              className="shrink-0 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition disabled:opacity-40 cursor-pointer"
            >
              {isConnectingCookie ? "Connecting..." : "Authenticate Cookie"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {notice && (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-3.5 text-xs text-indigo-700 dark:text-indigo-300">
          <span>{notice}</span>
          {connectUrl && hasConnecting && (
            <div>
              <a
                href={connectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 transition"
              >
                Open Instagram Login Page &rarr;
              </a>
            </div>
          )}
        </div>
      )}

      <div className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Status: <span className="text-primary font-bold">{overallStatus}</span>
        </h3>

        {isLoading ? (
          <p className="mt-3 text-xs text-muted">Loading sender accounts...</p>
        ) : senders.length === 0 ? (
          <p className="mt-3 text-xs text-muted">
            No Instagram sender account configured yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {senders.map((sender) => (
              <li
                key={sender.id}
                data-testid={`sender-${sender.status}`}
                className="rounded-xl border border-subtle bg-subtle p-4 transition-colors"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-primary">
                        @{sender.username}
                      </span>
                      {getStatusBadge(sender.status)}
                    </div>
                    {sender.displayName && (
                      <p className="text-xs text-muted">{sender.displayName}</p>
                    )}
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] text-muted sm:grid-cols-2">
                      <div>
                        <dt className="inline text-muted">Session type: </dt>
                        <dd className="inline font-medium text-secondary">{sender.sessionType}</dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Last verified: </dt>
                        <dd className="inline font-medium text-secondary">
                          {sender.lastVerifiedAt
                            ? new Date(sender.lastVerifiedAt).toLocaleString()
                            : "Never"}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Sent Today: </dt>
                        <dd className="inline font-medium text-secondary font-mono">
                          {sender.sentToday ?? 0} / {sender.effectiveDailyCap ?? 25} (Hour: {sender.sentThisHour ?? 0} / {sender.effectiveHourlyCap ?? 6})
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Warm-up Stage: </dt>
                        <dd className="inline font-medium text-secondary">
                          {sender.warmupStage || "Fully Warmed"}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Total Sent: </dt>
                        <dd className="inline font-medium text-secondary font-mono">
                          {sender.totalSent ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Next Send Allowed: </dt>
                        <dd className="inline font-medium text-secondary">
                          {sender.nextAllowedSendAt
                            ? new Date(sender.nextAllowedSendAt).toLocaleTimeString()
                            : (sender.lastSentAt ? "Ready (gap elapsed)" : "Ready")}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Working Window: </dt>
                        <dd className="inline font-medium text-secondary">
                          {String(sender.workingHoursStart ?? 9).padStart(2, "0")}:00 - {String(sender.workingHoursEnd ?? 18).padStart(2, "0")}:00 ({sender.timezone ?? "UTC"})
                        </dd>
                      </div>
                      {sender.lastErrorCode && (
                        <div>
                          <dt className="inline text-rose-500 font-semibold">Last Danger Code: </dt>
                          <dd className="inline font-medium text-rose-400 font-mono">
                            {sender.lastErrorCode} ({sender.consecutiveErrors ?? 0} consecutive)
                          </dd>
                        </div>
                      )}
                    </dl>
                    {sender.lastError && (
                      <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2.5 text-[11px] text-rose-700 dark:text-rose-400">
                        <span className="font-semibold">Error: </span>
                        {sender.lastError}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {sender.status === "CONNECTING" ? (
                      <button
                        type="button"
                        id="connect-sender-btn"
                        disabled
                        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 opacity-60"
                      >
                        Connecting...
                      </button>
                    ) : sender.status === "CONNECTED" ? (
                      <div className="flex items-center gap-2">
                        <span className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                          Connected
                        </span>
                        <button
                          type="button"
                          id="reconnect-sender-btn"
                          onClick={() => handleConnectSender(sender)}
                          disabled={busyId !== null || hasConnecting}
                          title="Generate a re-authentication link if session expired"
                          className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-primary transition-all cursor-pointer disabled:opacity-40"
                        >
                          {busyId === sender.id ? "Opening..." : "Reconnect"}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          id="connect-sender-btn"
                          onClick={() => handleConnectSender(sender)}
                          disabled={busyId !== null || hasConnecting}
                          className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 text-xs font-medium shadow-sm transition-all disabled:opacity-40 cursor-pointer"
                        >
                          {busyId === sender.id
                            ? "Opening..."
                            : sender.status === "AUTH_REQUIRED" || sender.status === "EXPIRED"
                              ? "Reconnect"
                              : "Connect"}
                        </button>
                        {(sender.status === "AUTH_REQUIRED" || sender.status === "EXPIRED") && (
                          <button
                            type="button"
                            id="cookie-reconnect-sender-btn"
                            onClick={() => {
                              setShowCookieModal(true);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                            className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-muted hover:text-primary transition-all cursor-pointer"
                          >
                            Paste Cookie
                          </button>
                        )}
                      </div>
                    )}

                    {(sender.status === "CONNECTING" || sender.status === "CONNECTED") && (
                      <button
                        type="button"
                        id="verify-sender-btn"
                        onClick={() => handleVerify(sender)}
                        disabled={busyId !== null}
                        className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary transition-all shadow-card disabled:opacity-40 cursor-pointer"
                      >
                        {busyId === sender.id ? "Verifying..." : "Verify Session"}
                      </button>
                    )}

                    {sender.status === "CONNECTING" && (
                      <button
                        type="button"
                        id="cancel-sender-login-btn"
                        onClick={() => handleCancelLogin(sender)}
                        disabled={busyId !== null}
                        className="rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                      >
                        Cancel Login
                      </button>
                    )}

                    {(sender.status === "PAUSED" || sender.status === "NEEDS_ATTENTION") && (
                      <button
                        type="button"
                        id={`resume-sender-${sender.id}-btn`}
                        onClick={() => handleResumeSender(sender)}
                        disabled={busyId !== null}
                        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {busyId === sender.id ? "Resuming..." : "Resume Outbound"}
                      </button>
                    )}

                    {(sender.status === "CONNECTED" || sender.status === "ACTIVE" || sender.status === "WARMING") && (
                      <button
                        type="button"
                        id={`pause-sender-${sender.id}-btn`}
                        onClick={() => handlePauseSender(sender)}
                        disabled={busyId !== null}
                        className="rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                      >
                        {busyId === sender.id ? "Pausing..." : "Pause Outbound"}
                      </button>
                    )}

                    <button
                      type="button"
                      id={`edit-limits-${sender.id}-btn`}
                      onClick={() => (editingSenderId === sender.id ? setEditingSenderId(null) : handleStartEdit(sender))}
                      className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover text-secondary px-3 py-1.5 text-xs font-medium transition-all shadow-card cursor-pointer"
                    >
                      {editingSenderId === sender.id ? "Close Limits" : "Safety Limits"}
                    </button>

                    <button
                      type="button"
                      id="disconnect-sender-btn"
                      onClick={() => handleDisconnect(sender)}
                      disabled={busyId !== null || sender.status === "DISCONNECTED"}
                      className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover text-muted hover:text-primary px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 cursor-pointer"
                    >
                      Disconnect
                    </button>

                    <button
                      type="button"
                      id={`delete-sender-${sender.id}-btn`}
                      onClick={() => handleDeleteSender(sender)}
                      disabled={busyId !== null}
                      className="rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 dark:text-rose-400 px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
                      title="Permanently remove account from database and UI"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      {busyId === sender.id ? "Deleting..." : "Delete Account"}
                    </button>
                  </div>
                </div>

                {editingSenderId === sender.id && (
                  <div className="mt-3 rounded-xl border border-indigo-500/30 bg-surface p-4 shadow-sm text-xs">
                    <h4 className="font-semibold text-primary mb-3">Configure Safety Limits & Schedule</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-muted text-[11px] mb-1 font-medium">Daily Send Cap (Max 40)</label>
                        <input
                          type="number"
                          min={1}
                          max={40}
                          value={editDailyCap}
                          onChange={(e) => setEditDailyCap(Math.min(40, Math.max(1, parseInt(e.target.value) || 1)))}
                          className="w-full rounded-lg border border-subtle bg-subtle px-2.5 py-1.5 text-xs font-mono text-primary"
                        />
                      </div>
                      <div>
                        <label className="block text-muted text-[11px] mb-1 font-medium">Hourly Send Cap (Max 10)</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={editHourlyCap}
                          onChange={(e) => setEditHourlyCap(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                          className="w-full rounded-lg border border-subtle bg-subtle px-2.5 py-1.5 text-xs font-mono text-primary"
                        />
                      </div>
                      <div>
                        <label className="block text-muted text-[11px] mb-1 font-medium">Working Hours Window</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={0}
                            max={23}
                            value={editHoursStart}
                            onChange={(e) => setEditHoursStart(parseInt(e.target.value) || 0)}
                            className="w-16 rounded-lg border border-subtle bg-subtle px-2 py-1.5 text-xs font-mono text-primary text-center"
                          />
                          <span className="text-muted">to</span>
                          <input
                            type="number"
                            min={0}
                            max={23}
                            value={editHoursEnd}
                            onChange={(e) => setEditHoursEnd(parseInt(e.target.value) || 0)}
                            className="w-16 rounded-lg border border-subtle bg-subtle px-2 py-1.5 text-xs font-mono text-primary text-center"
                          />
                        </div>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-muted text-[11px] mb-1 font-medium">Sender Timezone</label>
                        <input
                          type="text"
                          value={editTimezone}
                          onChange={(e) => setEditTimezone(e.target.value)}
                          placeholder="e.g. UTC, America/New_York, Europe/London"
                          className="w-full rounded-lg border border-subtle bg-subtle px-2.5 py-1.5 text-xs text-primary font-mono"
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingSenderId(null)}
                        className="rounded-lg border border-subtle px-3 py-1.5 text-xs text-muted hover:text-primary transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveSettings(sender.id)}
                        disabled={busyId === sender.id}
                        className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 text-xs font-medium shadow-sm transition disabled:opacity-40"
                      >
                        {busyId === sender.id ? "Saving..." : "Save Limits"}
                      </button>
                    </div>
                  </div>
                )}

                {sender.status === "CONNECTING" && (
                  <div
                    data-testid="interactive-login-panel"
                    className="mt-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3.5 text-[11px] text-indigo-900 dark:text-indigo-200"
                  >
                    <p className="font-semibold">Instagram browser opened — authentication in progress</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
                      <li>Log into Instagram in the browser window. Keep the browser open.</li>
                      <li>Complete 2FA/security verification if requested.</li>
                      <li>Once connected (&ldquo;Account successfully added!&rdquo;), this page syncs automatically.</li>
                      <li>Or click <strong>Verify Session</strong> above to confirm immediately.</li>
                    </ul>
                    <p className="mt-2 text-muted">
                      Elapsed: {elapsedLabel(sender.updatedAt, nowMs)}
                      {sender.username.startsWith("pending_")
                        ? ""
                        : ` · @${sender.username}`}
                    </p>
                  </div>
                )}

                {(sender.status === "CONNECTING" || sender.status === "CONNECTED") && (
                  <SenderDiagnosticsPanel
                    diagnostics={sender.sessionDiagnostics}
                    status={sender.status}
                  />
                )}

                {sender.status === "CONNECTED" && (
                  <div className="mt-3 rounded-xl border border-subtle bg-surface p-3 text-[11px] text-secondary">
                    <p className="font-semibold text-primary">
                      DM composer diagnostic (no message is sent)
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={dmTarget}
                        onChange={(e) => setDmTarget(e.target.value)}
                        placeholder="target Instagram username"
                        className="w-56 rounded-lg border border-subtle bg-subtle px-3 py-1.5 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => handleDiagnoseDm(sender)}
                        disabled={busyId !== null || dmTarget.trim().length === 0}
                        className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary transition shadow-card disabled:opacity-40 cursor-pointer"
                      >
                        {busyId === sender.id ? "Checking..." : "Test Composer Detection"}
                      </button>
                    </div>
                    {dmResult && (
                      <div className="mt-2 space-y-0.5 text-secondary">
                        <p>
                          Composer found:{" "}
                          <strong className={dmResult.composerFound ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                            {String(dmResult.composerFound)}
                          </strong>
                          {dmResult.code ? ` · code: ${dmResult.code}` : ""}
                        </p>
                        <p>
                          State: {dmResult.diagnostics.pageState} · URL:{" "}
                          {dmResult.diagnostics.currentUrl || "-"}
                        </p>
                        {dmResult.diagnostics.messageActionFound && (
                          <p>Message action: {dmResult.diagnostics.messageActionFound}</p>
                        )}
                        {dmResult.diagnostics.composerFound && (
                          <p>Composer: {dmResult.diagnostics.composerFound}</p>
                        )}
                        {dmResult.message && (
                          <p className="text-amber-600 dark:text-amber-400">{dmResult.message}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
