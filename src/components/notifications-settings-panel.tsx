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
      "DAILY_SUMMARY",
    ],
  });

  const [tokenInput, setTokenInput] = useState("");
  const [isEditingToken, setIsEditingToken] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSendingSummary, setIsSendingSummary] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<NotificationLogItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/notifications/config");
      if (!res.ok) throw new Error("Failed to load notification settings");
      const data = await res.json();
      if (data.config) {
        setConfig({
          ntfyTopic: data.config.ntfyTopic || "",
          ntfyServerUrl: data.config.ntfyServerUrl || "https://ntfy.sh",
          hasAccessToken: Boolean(data.config.hasAccessToken),
          maskedAccessToken: data.config.maskedAccessToken || null,
          enabled: Boolean(data.config.enabled),
          eventTypes: Array.isArray(data.config.eventTypes) ? data.config.eventTypes : [],
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await fetch("/api/notifications/log?pageSize=5");
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {
      // safe ignore
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) {
        void fetchConfig();
        void fetchLogs();
      }
    });
    return () => {
      ignore = true;
    };
  }, [fetchConfig, fetchLogs]);

  const handleToggleEventType = (key: string) => {
    setConfig((prev) => {
      const current = prev.eventTypes;
      const next = current.includes(key)
        ? current.filter((t) => t !== key)
        : [...current, key];
      return { ...prev, eventTypes: next };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!config.ntfyTopic.trim()) {
      setErrorMsg("Please enter an ntfy topic name.");
      return;
    }

    setIsSaving(true);
    try {
      const payload: Record<string, unknown> = {
        ntfyTopic: config.ntfyTopic.trim(),
        ntfyServerUrl: config.ntfyServerUrl.trim() || "https://ntfy.sh",
        enabled: config.enabled,
        eventTypes: config.eventTypes,
      };

      if (isEditingToken) {
        payload.ntfyAccessToken = tokenInput.trim() || null;
      }

      const res = await fetch("/api/notifications/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to save notification settings");
      }

      setSuccessMsg("Notification settings saved successfully.");
      setIsEditingToken(false);
      setTokenInput("");
      if (data.config) {
        setConfig({
          ntfyTopic: data.config.ntfyTopic,
          ntfyServerUrl: data.config.ntfyServerUrl,
          hasAccessToken: Boolean(data.config.hasAccessToken),
          maskedAccessToken: data.config.maskedAccessToken,
          enabled: Boolean(data.config.enabled),
          eventTypes: data.config.eventTypes,
        });
      }
      fetchLogs();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTest = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!config.ntfyTopic.trim()) {
      setErrorMsg("Please specify a topic name before testing.");
      return;
    }

    setIsTesting(true);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ntfyTopic: config.ntfyTopic.trim(),
          ntfyServerUrl: config.ntfyServerUrl.trim() || "https://ntfy.sh",
          ntfyAccessToken: isEditingToken ? tokenInput.trim() || undefined : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Test notification delivery failed");
      }

      setSuccessMsg(`Test alert delivered successfully (${data.latencyMs ?? 0}ms)! Check your ntfy client.`);
      fetchLogs();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Test notification failed");
    } finally {
      setIsTesting(false);
    }
  };

  const handleSendDailySummary = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsSendingSummary(true);

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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <span>🔔</span> Push Notifications (ntfy.sh)
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
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
            <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
          <span className="text-sm font-medium text-zinc-300">
            {config.enabled ? "Active" : "Disabled"}
          </span>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 text-sm text-red-400 bg-red-950/40 border border-red-800/60 rounded-md">
          {errorMsg}
        </div>
      )}

      {successMsg && (
        <div className="p-3 text-sm text-emerald-400 bg-emerald-950/40 border border-emerald-800/60 rounded-md">
          {successMsg}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">
              ntfy Topic Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Instagram_notification"
              value={config.ntfyTopic}
              onChange={(e) => setConfig((prev) => ({ ...prev, ntfyTopic: e.target.value }))}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Download the <strong>ntfy app</strong> on your phone (iOS / Android) and subscribe to this topic name.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">
              Server URL
            </label>
            <input
              type="url"
              placeholder="https://ntfy.sh"
              value={config.ntfyServerUrl}
              onChange={(e) => setConfig((prev) => ({ ...prev, ntfyServerUrl: e.target.value }))}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Leave as <code>https://ntfy.sh</code> to use the public server, or enter your self-hosted URL.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-300 mb-1">
            Access Token (Optional for protected topics)
          </label>
          {!isEditingToken && config.hasAccessToken ? (
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-zinc-400 bg-zinc-800/80 px-3 py-1.5 rounded border border-zinc-700">
                {config.maskedAccessToken || "****"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsEditingToken(true);
                  setTokenInput("");
                }}
                className="text-xs text-blue-400 hover:text-blue-300 underline"
              >
                Change Token
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingToken(true);
                  setTokenInput("");
                }}
                className="text-xs text-zinc-400 hover:text-zinc-300 underline"
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
                className="max-w-md w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
              />
              {config.hasAccessToken && (
                <button
                  type="button"
                  onClick={() => setIsEditingToken(false)}
                  className="text-xs text-zinc-400 hover:text-zinc-300 px-2 py-1"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
          <p className="mt-1 text-xs text-zinc-500">
            Only required if your topic is protected with an ntfy write token.
          </p>
        </div>

        <div className="border-t border-zinc-800 pt-4">
          <label className="block text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">
            Subscribed Events
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {ALL_EVENT_TYPES.map((ev) => {
              const isChecked = config.eventTypes.includes(ev.key);
              return (
                <label
                  key={ev.key}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    isChecked
                      ? "border-blue-700/60 bg-blue-950/20"
                      : "border-zinc-800 bg-zinc-800/40 hover:border-zinc-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggleEventType(ev.key)}
                    className="mt-1 h-4 w-4 rounded border-zinc-600 bg-zinc-700 text-blue-600 focus:ring-blue-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-zinc-200 block">
                      {ev.label}
                    </span>
                    <span className="text-xs text-zinc-400 block mt-0.5">
                      {ev.desc}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isTesting || !config.ntfyTopic}
              onClick={handleSendTest}
              className="inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 transition"
            >
              {isTesting ? "Testing..." : "Send Test Push"}
            </button>
            <button
              type="button"
              disabled={isSendingSummary || !config.enabled}
              onClick={handleSendDailySummary}
              className="inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 transition"
            >
              {isSendingSummary ? "Sending..." : "Send Daily Summary Now"}
            </button>
          </div>

          <button
            type="submit"
            disabled={isSaving || isLoading}
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition"
          >
            {isSaving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </form>

      {/* Recent Delivery Logs */}
      <div className="border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Recent Delivery Logs (Past 5)
          </h3>
          <button
            type="button"
            onClick={fetchLogs}
            disabled={loadingLogs}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline"
          >
            {loadingLogs ? "Refreshing..." : "Refresh Logs"}
          </button>
        </div>

        {logs.length === 0 ? (
          <p className="text-xs text-zinc-500 italic py-2">
            No notification logs yet. Send a test push to verify delivery.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-zinc-300">
              <thead className="bg-zinc-800/60 text-zinc-400 border-b border-zinc-800">
                <tr>
                  <th className="py-2 px-3">Event</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Latency</th>
                  <th className="py-2 px-3">Time</th>
                  <th className="py-2 px-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-zinc-800/30">
                    <td className="py-2 px-3 font-mono text-[11px] text-zinc-300">
                      {log.eventType}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                          log.status === "SENT"
                            ? "bg-emerald-950/80 text-emerald-300 border border-emerald-800/60"
                            : log.status === "SKIPPED_DISABLED"
                            ? "bg-zinc-800 text-zinc-400"
                            : "bg-red-950/80 text-red-300 border border-red-800/60"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-zinc-400">
                      {log.latencyMs !== null ? `${log.latencyMs}ms` : "-"}
                    </td>
                    <td className="py-2 px-3 text-zinc-400">
                      {new Date(log.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="py-2 px-3 text-zinc-400 truncate max-w-xs">
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
