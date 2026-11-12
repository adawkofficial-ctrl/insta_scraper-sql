"use client";

import { useCallback, useEffect, useState } from "react";

type EmailAccount = {
  id: string;
  fromName: string;
  fromAddress: string;
  postalAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  secure: boolean;
  status: string;
  dailyCap: number;
  hourlyCap: number;
  spfStatus: string | null;
  dkimStatus: string | null;
  dmarcStatus: string | null;
  dkimSelector: string | null;
  allowDnsOverride: boolean;
  freeProviderWarning: boolean;
  lastError: string | null;
  pausedUntil: string | null;
  warmupStartedAt: string | null;
};

const EMPTY = {
  fromName: "",
  fromAddress: "",
  postalAddress: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  secure: true,
  dailyCap: 10,
  hourlyCap: 4,
  dkimSelector: "",
  allowDnsOverride: false,
};

export default function EmailAccountsPage() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/email/accounts", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { accounts: EmailAccount[] };
    setAccounts(json.accounts);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/email/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, dkimSelector: form.dkimSelector || null }),
      });
      const json = (await res.json()) as { message?: string };
      setMessage(res.ok ? "SMTP account saved." : (json.message ?? "Failed to save account."));
      if (res.ok) {
        setForm({ ...EMPTY });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, path: string, label: string): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/email/accounts/${id}/${path}`, { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      setMessage(res.ok ? `${label}: OK` : `${label}: ${json.error ?? "failed"}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string): Promise<void> {
    await fetch(`/api/email/accounts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Email sender account</h1>
          <p className="mt-1 text-sm text-zinc-400">
            SMTP credentials are encrypted at rest and never returned by the API. Check the mailbox
            daily for STOP replies.
          </p>
        </header>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h2 className="text-sm font-semibold">Add account</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {([
              ["fromName", "From name"],
              ["fromAddress", "From address"],
              ["postalAddress", "Postal address (CASL footer)"],
              ["smtpHost", "SMTP host"],
              ["smtpUser", "SMTP username"],
              ["smtpPassword", "SMTP password"],
              ["dkimSelector", "DKIM selector"],
            ] as const).map(([key, label]) => (
              <label key={key} className="text-xs text-zinc-400">
                {label}
                <input
                  type={key === "smtpPassword" ? "password" : "text"}
                  value={String(form[key])}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                />
              </label>
            ))}
            <label className="text-xs text-zinc-400">
              SMTP port
              <input
                type="number"
                value={form.smtpPort}
                onChange={(e) => setForm((f) => ({ ...f, smtpPort: Number(e.target.value) }))}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              />
            </label>
            <label className="text-xs text-zinc-400">
              Daily cap
              <input
                type="number"
                value={form.dailyCap}
                onChange={(e) => setForm((f) => ({ ...f, dailyCap: Number(e.target.value) }))}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={form.secure}
                onChange={(e) => setForm((f) => ({ ...f, secure: e.target.checked }))}
              />
              TLS/SSL
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={form.allowDnsOverride}
                onChange={(e) => setForm((f) => ({ ...f, allowDnsOverride: e.target.checked }))}
              />
              Allow DNS override
            </label>
          </div>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="mt-3 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Save account
          </button>
          {message && <p className="mt-2 text-xs text-zinc-300">{message}</p>}
        </section>

        {accounts.map((account) => (
          <section key={account.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">
                  {account.fromName} &lt;{account.fromAddress}&gt;
                </h2>
                <p className="text-xs text-zinc-500">
                  {account.smtpHost}:{account.smtpPort} · status {account.status} · caps {account.dailyCap}/day,{" "}
                  {account.hourlyCap}/hour
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => action(account.id, "verify", "Verify")} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs">
                  Verify connection
                </button>
                <button type="button" onClick={() => action(account.id, "test-send", "Test email")} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs">
                  Send test email
                </button>
                <button type="button" onClick={() => action(account.id, "dns-check", "DNS check")} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs">
                  Check DNS
                </button>
                <button type="button" onClick={() => setStatus(account.id, account.status === "ACTIVE" ? "PAUSED" : "ACTIVE")} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs">
                  {account.status === "ACTIVE" ? "Pause" : "Enable"}
                </button>
              </div>
            </div>
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
              <div className="rounded-lg bg-zinc-950/60 p-2">SPF: <strong>{account.spfStatus ?? "UNKNOWN"}</strong></div>
              <div className="rounded-lg bg-zinc-950/60 p-2">DKIM: <strong>{account.dkimStatus ?? "UNKNOWN"}</strong></div>
              <div className="rounded-lg bg-zinc-950/60 p-2">DMARC: <strong>{account.dmarcStatus ?? "UNKNOWN"}</strong></div>
            </div>
            {account.freeProviderWarning && (
              <p className="mt-2 text-xs text-amber-300">
                Warning: the from-domain is a free email provider. Use a domain you control for deliverability.
              </p>
            )}
            {account.lastError && <p className="mt-2 text-xs text-rose-300">Last error: {account.lastError}</p>}
          </section>
        ))}
      </div>
    </main>
  );
}
