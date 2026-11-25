"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function CampaignError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Campaign Error Boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-white">Campaign View Error</h3>
        <p className="text-xs text-zinc-400">
          Failed to load this campaign. It may not exist, or an upstream service may be temporarily unavailable.
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <button
            onClick={() => reset()}
            className="rounded-lg bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-500"
          >
            Retry
          </button>
          <Link
            href="/"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-700"
          >
            All Campaigns
          </Link>
        </div>
      </div>
    </div>
  );
}
