"use client";

import { useCallback, useEffect, useState } from "react";

type EmailSettings = {
  subjectTemplate: string;
  bodyTemplate: string;
  enabled: boolean;
  templateVersion: number;
};

type EmailQueueItem = {
  id: string;
  status: string;
  recipient: string;
  subject: string;
  createdAt: string;
  sentAt: string | null;
  errorCode: string | null;
  lead: { fullName: string | null; email: string | null; username: string | null } | null;
};

type EmailData = {
  settings: EmailSettings | null;
  counts: Record<string, number>;
  queue: EmailQueueItem[];
};

export function CampaignEmailTab({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<EmailData | null>(null);
  const [subject, setSubject] = useState("Quick question for {businessName}");
  const [body, setBody] = useState(
    "I came across {businessName} in {city} and wanted to ask a quick question about your marketing.",
  );
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string; needsEdit: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}/email`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as EmailData;
    setData(json);
    if (json.settings) {
      setSubject(json.settings.subjectTemplate);
      setBody(json.settings.bodyTemplate);
      setEnabled(json.settings.enabled);
    }
  }, [campaignId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/email`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectTemplate: subject, bodyTemplate: body, enabled }),
      });
      setMessage(res.ok ? "Email settings saved." : "Failed to save email settings.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function previewForFirstLead(): Promise<void> {
    const res = await fetch(`/api/campaigns/${campaignId}/email/preview`, { cache: "no-store" });
    if (!res.ok) {
      setPreview(null);
      return;
    }
    setPreview((await res.json()) as { subject: string; body: string; needsEdit: boolean });
  }

  async function sendBatch(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/email/send`, { method: "POST" });
      const json = (await res.json()) as Record<string, unknown>;
      setMessage(
        res.ok
          ? `Processed ${json.processed ?? 0}: sent ${json.sent ?? 0}, failed ${json.failed ?? 0}, suppressed ${json.suppressed ?? 0}, unknown ${json.unknown ?? 0}.`
          : String(json.message ?? json.error ?? "Send failed."),
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
        Check the mailbox daily for STOP replies and use the lead actions to mark replies/DNC within 24 hours.
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">Email templates</h3>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
        <label className="mt-3 block text-xs text-zinc-400">
          Subject
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
        <label className="mt-3 block text-xs text-zinc-400">
          Body (plain text)
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            Save templates
          </button>
          <button
            type="button"
            onClick={previewForFirstLead}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200"
          >
            Preview final text
          </button>
          <button
            type="button"
            onClick={sendBatch}
            disabled={busy || !enabled}
            className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            Send next batch
          </button>
        </div>
        {message && <p className="mt-2 text-xs text-zinc-300">{message}</p>}
        {preview && (
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-900 p-3 text-[11px] text-zinc-300">
            {`Subject: ${preview.subject}\n\n${preview.body}`}
          </pre>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <h3 className="text-sm font-semibold text-zinc-200">Queue</h3>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-400">
          {Object.entries(data?.counts ?? {}).map(([status, count]) => (
            <span key={status}>
              {status}: <strong className="text-zinc-200">{count}</strong>
            </span>
          ))}
        </div>
        <div className="mt-3 max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1">Lead</th>
                <th className="py-1">Recipient</th>
                <th className="py-1">Status</th>
                <th className="py-1">Sent</th>
              </tr>
            </thead>
            <tbody>
              {(data?.queue ?? []).map((item) => (
                <tr key={item.id} className="border-t border-zinc-800/70">
                  <td className="py-1.5 text-zinc-300">{item.lead?.fullName ?? item.lead?.username ?? "—"}</td>
                  <td className="py-1.5 text-zinc-400">{item.recipient}</td>
                  <td className="py-1.5 text-zinc-300">{item.status}</td>
                  <td className="py-1.5 text-zinc-500">
                    {item.sentAt ? new Date(item.sentAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
