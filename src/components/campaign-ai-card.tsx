"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import {
  getCompanyProfileById,
  type CompanyProfileCompleteness,
} from "@/lib/api/company-profile";
import { apiFetch, ApiClientError } from "@/lib/api/client";
import type { CampaignDetail } from "@/lib/api/campaigns";

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];

export function CampaignAiCard({
  campaignId,
  companyProfileId,
  companyProfileName,
}: {
  campaignId: string;
  companyProfileId?: string;
  companyProfileName?: string;
}) {
  const [profileName, setProfileName] = useState<string>(companyProfileName || "");
  const [completeness, setCompleteness] = useState<CompanyProfileCompleteness | null>(null);
  const [limit, setLimit] = useState(25);
  const [generateDrafts, setGenerateDrafts] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load campaign profile if not provided
  useEffect(() => {
    let ignore = false;
    const resolveAndLoad = async () => {
      try {
        let activeProfileId = companyProfileId;
        let activeName = companyProfileName;

        if (!activeProfileId) {
          const camp = await apiFetch<CampaignDetail>(`/api/campaigns/${campaignId}`);
          activeProfileId = camp.companyProfileId;
          activeName = camp.companyProfile?.name || "";
          if (!ignore) {
            setProfileName(activeName);
          }
        }

        if (activeProfileId) {
          const res = await getCompanyProfileById(activeProfileId);
          if (!ignore) {
            setCompleteness(res.completeness);
            if (res.profile?.name) setProfileName(res.profile.name);
          }
        }
      } catch {
        if (!ignore) setError("Could not load the attached company profile.");
      }
    };

    void resolveAndLoad();
    return () => {
      ignore = true;
    };
  }, [campaignId, companyProfileId, companyProfileName]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch<{
          job: { status: string; processed: number; total: number };
        }>(`/api/ai-jobs/${jobId}`);
        if (cancelled) return;
        setProgress(`${res.job.status} · ${res.job.processed}/${res.job.total}`);
        if (TERMINAL.includes(res.job.status)) clearInterval(timer);
      } catch {
        // keep polling
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId]);

  const complete = completeness?.complete ?? false;

  const start = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const res = await apiFetch<{ jobId: string; total: number }>(
        `/api/campaigns/${campaignId}/ai/analyze`,
        { method: "POST", body: JSON.stringify({ limit, generateDrafts }) },
      );
      setJobId(res.jobId);
      setProgress(`PENDING · 0/${res.total}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to start AI analysis.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-zinc-100">AI qualification</h3>
            {profileName && (
              <span className="rounded bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 text-[11px] font-medium text-indigo-300">
                AI will use profile: <strong className="font-semibold text-indigo-200">{profileName}</strong>
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-400">
            Analyze leads and (optionally) generate message drafts using this campaign&apos;s attached profile.
          </p>
        </div>
        {completeness &&
          (complete ? (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-400">
              Ready for AI
            </span>
          ) : (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300">
              Company profile incomplete
            </span>
          ))}
      </div>

      {completeness && !complete && (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          Profile <strong>&quot;{profileName}&quot;</strong> is missing: {completeness.missingFields.join(", ")}. Complete this profile in{" "}
          <Link href="/settings" className="underline font-semibold hover:text-white">
            Settings → Company Profiles
          </Link>{" "}
          before analyzing.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Limit
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={generateDrafts}
            onChange={(e) => setGenerateDrafts(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-950"
          />
          Also generate drafts
        </label>
        <button
          type="button"
          id="campaign-ai-analyze"
          onClick={start}
          disabled={!complete || busy}
          title={complete ? undefined : `Complete profile "${profileName}" in Settings first`}
          className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Starting..." : "Analyze"}
        </button>
        {progress && <span className="text-xs text-zinc-400">{progress}</span>}
      </div>
    </section>
  );
}
