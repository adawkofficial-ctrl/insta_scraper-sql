"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function UnsubscribePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const [state, setState] = useState<"loading" | "ready" | "done" | "invalid">("loading");
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/email/unsubscribe/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          setState("invalid");
          return;
        }
        const data = (await res.json()) as { valid: boolean; used: boolean; email: string | null };
        setEmail(data.email);
        setState(data.valid ? "ready" : "invalid");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  async function unsubscribe(): Promise<void> {
    if (!token) return;
    const res = await fetch(`/api/email/unsubscribe/${encodeURIComponent(token)}`, {
      method: "POST",
    });
    setState(res.ok ? "done" : "invalid");
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-16 text-zinc-100">
      <div className="mx-auto max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <h1 className="text-2xl font-semibold">Email unsubscribe</h1>
        {state === "loading" && <p className="mt-4 text-zinc-400">Checking link…</p>}
        {state === "invalid" && (
          <p className="mt-4 text-rose-300">This unsubscribe link is invalid or expired.</p>
        )}
        {state === "ready" && (
          <div className="mt-4 space-y-4">
            <p className="text-zinc-300">
              {email ? <strong>{email}</strong> : "This address"} will be added to our Do Not Contact
              list.
            </p>
            <button
              type="button"
              onClick={unsubscribe}
              className="rounded-lg bg-orange-600 px-4 py-2 font-medium text-white hover:bg-orange-500"
            >
              Unsubscribe
            </button>
          </div>
        )}
        {state === "done" && (
          <p className="mt-4 text-emerald-300">
            You have been unsubscribed. You will not receive further emails from us.
          </p>
        )}
      </div>
    </main>
  );
}
