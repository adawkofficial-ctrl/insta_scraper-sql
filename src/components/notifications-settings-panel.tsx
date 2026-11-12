"use client";

import { useEffect, useState, useCallback } from "react";

type NotificationConfigData = {
  id?: string;
  userId?: string;
  ntfyTopic: string;
  ntfyServerUrl: string;
  hasAccessToken: boolean;
  maskedAccessToken: string | null;
  enabled: boolean;
  eventTypes: string[];
};

type NotificationLogItem = {
  id: string;
  eventType: string;
  status: "SENT" | "FAILED" | "SKIPPED_DISABLED";
  errorReason: string | null;
  latencyMs: number | null;
  createdAt: string;
};

const ALL_EVENT_TYPES = [
  {
    key: "LEAD_REPLIED",
    label: "Inbound Lead Replies",
    desc: "Alert when a lead replies to an outreach DM with message preview",
  },
  {
    key: "HIGH_VALUE_LEAD",
    label: "High-Value Leads",
    desc: "Alert when a lead score crosses the threshold (≥85) for the first time",
  },
  {
    key: "SESSION_EXPIRED",
    label: "Session Expired",
    desc: "Alert when an Instagram sender requires re-authentication",
  },
  {
    key: "SENDER_ERROR",
    label: "Sender Account Errors",
    desc: "Alert when a sender account encounters a rate limit or dispatch error",
  },
  {
    key: "SYSTEM_ERROR",
    label: "Provider & System Errors",
    desc: "Alert when Apify, Sparior, or Gemini run out of quota or fail auth",
  },
  {
    key: "DAILY_SUMMARY",
    label: "Daily Activity Summary",
    desc: "Aggregated 24h summary of new leads, sent DMs, and replies",
  },
];

export function NotificationSettingsPanel() {
  const [config, setConfig] = useState<NotificationConfigData>({
    ntfyTopic: "",
    ntfyServerUrl: "https://ntfy.sh",
    hasAccessToken: false,
    maskedAccessToken: null,
    enabled: true,
    eventTypes: [
      "LEAD_REPLIED",
      "HIGH_VALUE_LEAD",
      "SESSION_EXPIRED",
      "SENDER_ERROR",
      "SYSTEM_ERROR",
    ],
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSendingSummary, setIsSendingSummary] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [isEditingToken, setIsEditingToken] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<NotificationLogItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/config");
      if (!res.ok) throw new Error("Failed to load notification settings");
      const data = await res.json();
      if (data.config) {
        setConfig(data.config);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Error loading settings");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await fetch("/api/notifications/log?limit=5");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {
      // Non-critical, ignore
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConfig();
    fetchLogs();
  }, [fetchConfig, fetchLogs]);

  const handleToggleEventType = (key: string) => {
    setConfig((prev) => {
      const exists = prev.eventTypes.includes(key);
      const updated = exists
        ? prev.eventTypes.filter((t) => t !== key)
        : [...prev.eventTypes, key];
      return { ...prev, eventTypes: updated };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const payload: Record<string, unknown> = {
        ntfyTopic: config.ntfyTopic.trim(),
        ntfyServerUrl: config.ntfyServerUrl.trim() || "https://ntfy.sh",
        enabled: config.enabled,
        eventTypes: config.eventTypes,
      };

      if (isEditingToken) {
        payload.accessToken = tokenInput.trim() || null;
      }

      const res = await fetch("/api/notifications/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to save settings");
      }

      setConfig(data.config);
      setIsEditingToken(false);
      setTokenInput("");
      setSuccessMsg("Notification settings saved successfully.");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTest = async () => {
    setIsTesting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to send test notification");
      }

      setSuccessMsg(
        `Test push sent to topic "${data.topic}"! Check your ntfy client. (Latency: ${data.latencyMs ?? 0}ms)`,
      );
      fetchLogs();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to send test");
    } finally {
      setIsTesting(false);
    }
  };

  const handleSendDailySummary = async () => {
    setIsSendingSummary(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/notifications/daily-summary", {
        method: "POST",
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to send daily summary");
      }

      setSuccessMsg("Daily summary notification dispatched successfully!");
      fetchLogs();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to send summary");
    } finally {
      setIsSendingSummary(false);
    }
  };

  return (
    <div className="rounded-2xl border border-subtle bg-surface shadow-card p-6 space-y-6 transition-colors">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-subtle pb-4">
        <div>
          <h2 className="text-lg font-bold text-primary flex items-center gap-2">
            <span>🔔</span> Push Notifications (ntfy.sh)
          </h2>
          <p className="mt-1 text-xs text-muted">
            Instant mobile and desktop push notifications for replies, high-value leads, and sender health.
            Free, no account or paid subscription needed.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={config.enabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            <div className="w-11 h-6 bg-subtle border border-subtle peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
          </label>
          <span className="text-sm font-semibold text-primary">
            {config.enabled ? "Active" : "Disabled"}
          </span>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-xs text-rose-700 dark:text-rose-300">
          {errorMsg}
        </div>
      )}

      {successMsg && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5 text-xs text-emerald-700 dark:text-emerald-300">
          {successMsg}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">
              ntfy Topic Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Instagram_notification"
              value={config.ntfyTopic}
              onChange={(e) => setConfig((prev) => ({ ...prev, ntfyTopic: e.target.value }))}
              className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors"
            />
            <p className="mt-1 text-xs text-muted">
              Download the <strong>ntfy app</strong> on your phone (iOS / Android) and subscribe to this topic name.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-secondary mb-1">
              Server URL
            </label>
            <input
              type="url"
              placeholder="https://ntfy.sh"
              value={config.ntfyServerUrl}
              onChange={(e) => setConfig((prev) => ({ ...prev, ntfyServerUrl: e.target.value }))}
              className="w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors"
            />
            <p className="mt-1 text-xs text-muted">
              Leave as <code>https://ntfy.sh</code> to use the public server, or enter your self-hosted URL.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-secondary mb-1">
            Access Token (Optional for protected topics)
          </label>
          {!isEditingToken && config.hasAccessToken ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs text-secondary bg-subtle px-3 py-1.5 rounded-lg border border-subtle">
                {config.maskedAccessToken || "****"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsEditingToken(true);
                  setTokenInput("");
                }}
                className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                Change Token
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingToken(true);
                  setTokenInput("");
                }}
                className="text-xs text-muted hover:text-primary underline cursor-pointer"
              >
                Clear
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="password"
                placeholder={config.hasAccessToken ? "Enter new token or leave empty to clear" : "tk_..."}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="max-w-md w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors"
              />
              {config.hasAccessToken && (
                <button
                  type="button"
                  onClick={() => setIsEditingToken(false)}
                  className="text-xs text-muted hover:text-primary px-2 py-1 cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-xs text-muted">
            Only required if your topic is protected with an ntfy write token.
          </p>
        </div>

        <div className="border-t border-subtle pt-4">
          <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-3">
            Subscribed Events
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ALL_EVENT_TYPES.map((ev) => {
              const isChecked = config.eventTypes.includes(ev.key);
              return (
                <label
                  key={ev.key}
                  className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                    isChecked
                      ? "border-indigo-500/30 bg-indigo-500/10"
                      : "border-subtle bg-subtle hover:bg-surface-hover"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggleEventType(ev.key)}
                    className="mt-1 h-4 w-4 rounded border-subtle bg-surface text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-xs font-semibold text-primary block">
                      {ev.label}
                    </span>
                    <span className="text-xs text-muted block mt-0.5">
                      {ev.desc}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-subtle">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isTesting || !config.ntfyTopic}
              onClick={handleSendTest}
              className="inline-flex items-center justify-center rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3.5 py-2 text-xs font-medium text-secondary hover:text-primary disabled:opacity-50 transition shadow-card cursor-pointer"
            >
              {isTesting ? "Testing..." : "Send Test Push"}
            </button>
            <button
              type="button"
              disabled={isSendingSummary || !config.enabled}
              onClick={handleSendDailySummary}
              className="inline-flex items-center justify-center rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3.5 py-2 text-xs font-medium text-secondary hover:text-primary disabled:opacity-50 transition shadow-card cursor-pointer"
            >
              {isSendingSummary ? "Sending..." : "Send Daily Summary Now"}
            </button>
          </div>

          <button
            type="submit"
            disabled={isSaving || isLoading}
            className="inline-flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 disabled:opacity-50 transition cursor-pointer"
          >
            {isSaving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>

      {/* Recent Delivery Logs */}
      <div className="border-t border-subtle pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
            Recent Delivery Logs (Past 5)
          </h3>
          <button
            type="button"
            onClick={fetchLogs}
            disabled={loadingLogs}
            className="text-xs text-muted hover:text-primary underline cursor-pointer"
          >
            {loadingLogs ? "Refreshing..." : "Refresh Logs"}
          </button>
        </div>

        {logs.length === 0 ? (
          <p className="text-xs text-muted italic py-2">
            No notification logs yet. Send a test push to verify delivery.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-subtle">
            <table className="w-full text-left text-xs text-secondary">
              <thead className="bg-subtle text-muted border-b border-subtle text-[11px] font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3">Event</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Latency</th>
                  <th className="py-2.5 px-3">Time</th>
                  <th className="py-2.5 px-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle bg-surface">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface-hover transition-colors">
                    <td className="py-2 px-3 font-mono text-[11px] text-primary">
                      {log.eventType}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          log.status === "SENT"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                            : log.status === "SKIPPED_DISABLED"
                            ? "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20"
                            : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-muted">
                      {log.latencyMs !== null ? `${log.latencyMs}ms` : "-"}
                    </td>
                    <td className="py-2 px-3 text-muted">
                      {new Date(log.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="py-2 px-3 text-muted truncate max-w-xs">
                      {log.errorReason || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
