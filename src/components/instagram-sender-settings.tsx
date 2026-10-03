"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cancelSenderLogin,
  connectSenderAccount,
  createSenderAccount,
  diagnoseSenderDm,
  disconnectSenderAccount,
  listSenderAccounts,
  verifySenderAccount,
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
    case "CONNECTED":
      return (
        <span className={`${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-400`}>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Connected
        </span>
      );
    case "CONNECTING":
      return (
        <span className={`${base} border-sky-500/30 bg-sky-500/10 text-sky-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />
          Connecting
        </span>
      );
    case "AUTH_REQUIRED":
    case "EXPIRED":
      return (
        <span className={`${base} border-amber-500/30 bg-amber-500/10 text-amber-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Authentication Required
        </span>
      );
    case "ERROR":
      return (
        <span className={`${base} border-rose-500/30 bg-rose-500/10 text-rose-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          Error
        </span>
      );
    default:
      return (
        <span className={`${base} border-zinc-600/40 bg-zinc-800/60 text-zinc-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
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
      className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3 text-[11px] text-zinc-400 sm:grid-cols-2"
    >
      <div>
        <dt className="inline text-zinc-500">Service: </dt>
        <dd className="inline text-zinc-300">
          {diagnostics?.browserName ?? "Unipile API"}
        </dd>
      </div>
      <div>
        <dt className="inline text-zinc-500">Mode: </dt>
        <dd className="inline text-zinc-300">
          {diagnostics?.mode === "manual-login" || status === "CONNECTING"
            ? "Hosted Authentication"
            : (diagnostics?.mode ?? "Unipile Gateway")}
        </dd>
      </div>

      <div>
        <dt className="inline text-zinc-500">Headed: </dt>
        <dd className="inline text-zinc-300">
          {String(diagnostics?.headed ?? status === "CONNECTING")}
        </dd>
      </div>
      <div>
        <dt className="inline text-zinc-500">Status: </dt>
        <dd className="inline text-zinc-300">{status}</dd>
      </div>
      <div>
        <dt className="inline text-zinc-500">Pages: </dt>
        <dd className="inline text-zinc-300">
          {live ? diagnostics?.pagesCount : "-"}
        </dd>
      </div>
      <div>
        <dt className="inline text-zinc-500">Current URL: </dt>
        <dd className="inline text-zinc-300">
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
    // Never start another connect while one is in progress.
    if (connectingSender) return;
    setIsCreating(true);
    setError(null);
    setNotice(null);
    try {
      // Reuse an existing not-yet-connected sender instead of accumulating
      // pending sender accounts; only create a new one when all are connected.
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

  const overallStatus = senders.some((s) => s.isConnected)
    ? "Connected"
    : hasConnecting
      ? "Connecting"
      : "Not Connected";

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
      <div className="flex flex-col gap-2 border-b border-zinc-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">Instagram Sender Account</h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            Connect an authorized Instagram account for single and bulk messaging via Unipile.
            Authentication is completed securely via Unipile hosted auth or session cookie; no Instagram password is ever
            stored by this app.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            id="connect-with-cookie-toggle-btn"
            onClick={() => setShowCookieModal((prev) => !prev)}
            className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3.5 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-600/20"
          >
            {showCookieModal ? "Close Cookie Login" : "Connect via Cookie (sessionid)"}
          </button>
          <button
            type="button"
            id="connect-instagram-account-btn"
            onClick={handleConnect}
            disabled={isCreating || busyId !== null || hasConnecting}
            className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-40"
          >
            {hasConnecting
              ? "Connecting..."
              : isCreating
                ? "Generating link..."
                : "Connect via Hosted Link"}
          </button>
        </div>
      </div>

      {showCookieModal && (
        <div className="mt-4 rounded-xl border border-emerald-500/30 bg-zinc-950/80 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-zinc-100 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Connect via Instagram Session Cookie (sessionid)
            </h4>
            <button
              type="button"
              onClick={() => setShowCookieModal(false)}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              &times;
            </button>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] text-zinc-400 space-y-1.5">
            <p className="font-semibold text-zinc-200">How to get your sessionid cookie (bypasses Instagram IP blocks):</p>
            <ol className="list-decimal pl-4 space-y-0.5 text-zinc-400">
              <li>Open <a href="https://www.instagram.com" target="_blank" rel="noopener noreferrer" className="text-sky-400 underline">instagram.com</a> in your browser where you are logged in.</li>
              <li>Press <kbd className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">F12</kbd> (or right click &gt; Inspect).</li>
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
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="button"
              id="authenticate-cookie-btn"
              onClick={() => handleConnectWithCookie()}
              disabled={isConnectingCookie || !cookieInput.trim()}
              className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
            >
              {isConnectingCookie ? "Connecting..." : "Authenticate Cookie"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {notice && (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-200">
          <span>{notice}</span>
          {connectUrl && hasConnecting && (
            <div>
              <a
                href={connectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 transition"
              >
                Open Instagram Login Page &rarr;
              </a>
            </div>
          )}
        </div>
      )}



      <div className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Status: {overallStatus}
        </h3>

        {isLoading ? (
          <p className="mt-3 text-xs text-zinc-500">Loading sender accounts...</p>
        ) : senders.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">
            No Instagram sender account configured yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {senders.map((sender) => (
              <li
                key={sender.id}
                data-testid={`sender-${sender.status}`}
                className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-100">
                        @{sender.username}
                      </span>
                      {getStatusBadge(sender.status)}
                    </div>
                    {sender.displayName && (
                      <p className="text-xs text-zinc-400">{sender.displayName}</p>
                    )}
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-[11px] text-zinc-400 sm:grid-cols-2">
                      <div>
                        <dt className="inline text-zinc-500">Session type: </dt>
                        <dd className="inline text-zinc-300">{sender.sessionType}</dd>
                      </div>
                      <div>
                        <dt className="inline text-zinc-500">Last verified: </dt>
                        <dd className="inline text-zinc-300">
                          {sender.lastVerifiedAt
                            ? new Date(sender.lastVerifiedAt).toLocaleString()
                            : "Never"}
                        </dd>
                      </div>
                    </dl>
                    {sender.lastError && (
                      <p className="mt-1 text-[11px] text-amber-300/90">
                        {sender.lastError}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    {sender.status === "CONNECTING" ? (
                      <button
                        type="button"
                        id="connect-sender-btn"
                        disabled
                        className="rounded-lg border border-sky-600/40 bg-sky-600/10 px-3 py-1.5 text-xs font-medium text-sky-300 opacity-60"
                      >
                        Connecting...
                      </button>
                    ) : sender.status === "CONNECTED" ? (
                      <span className="rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                        Connected
                      </span>
                    ) : (
                      <button
                        type="button"
                        id="connect-sender-btn"
                        onClick={() => handleConnectSender(sender)}
                        disabled={busyId !== null || hasConnecting}
                        className="rounded-lg border border-sky-600/40 bg-sky-600/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-600/20 disabled:opacity-40"
                      >
                        {busyId === sender.id ? "Opening..." : "Connect"}
                      </button>
                    )}

                    {(sender.status === "CONNECTING" || sender.status === "CONNECTED") && (
                      <button
                        type="button"
                        id="verify-sender-btn"
                        onClick={() => handleVerify(sender)}
                        disabled={busyId !== null}
                        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
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
                        className="rounded-lg border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-600/20 disabled:opacity-40"
                      >
                        Cancel Login
                      </button>
                    )}

                    <button
                      type="button"
                      id="disconnect-sender-btn"
                      onClick={() => handleDisconnect(sender)}
                      disabled={busyId !== null || sender.status === "DISCONNECTED"}
                      className="rounded-lg border border-rose-600/40 bg-rose-600/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-600/20 disabled:opacity-40"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>

                {sender.status === "CONNECTING" && (
                  <div
                    data-testid="interactive-login-panel"
                    className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-[11px] text-sky-100"
                  >
                    <p className="font-semibold">Instagram browser opened — authentication in progress</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sky-200/90">
                      <li>Log into Instagram in the browser window. Keep the browser open.</li>
                      <li>Complete 2FA/security verification if requested.</li>
                      <li>Once connected (&ldquo;Account successfully added!&rdquo;), this page syncs automatically.</li>
                      <li>Or click <strong>Verify Session</strong> above to confirm immediately.</li>
                    </ul>
                    <p className="mt-2 text-sky-200/80">
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
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[11px] text-zinc-300">
                    <p className="font-semibold text-zinc-200">
                      DM composer diagnostic (no message is sent)
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={dmTarget}
                        onChange={(e) => setDmTarget(e.target.value)}
                        placeholder="target Instagram username"
                        className="w-56 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleDiagnoseDm(sender)}
                        disabled={busyId !== null || dmTarget.trim().length === 0}
                        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
                      >
                        {busyId === sender.id ? "Checking..." : "Test Composer Detection"}
                      </button>
                    </div>
                    {dmResult && (
                      <div className="mt-2 space-y-0.5 text-zinc-300">
                        <p>
                          Composer found:{" "}
                          <strong className={dmResult.composerFound ? "text-emerald-400" : "text-rose-400"}>
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
                          <p className="text-amber-300">{dmResult.message}</p>
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
