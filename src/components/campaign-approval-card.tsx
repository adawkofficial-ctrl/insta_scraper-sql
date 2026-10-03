"use client";

import { useEffect, useState } from "react";
import {
  updateCampaign,
  getCampaignApprovalEligibility,
  type ApprovalMode,
  type AutoApprovalEligibility,
} from "@/lib/api/campaigns";
import { ApiClientError } from "@/lib/api/client";

export type CampaignApprovalCardProps = {
  campaignId: string;
  requireApproval?: boolean;
  approvalMode?: ApprovalMode;
  autoApproveMinScore?: number;
  qualityMaxRegenerations?: number;
  onUpdated?: (updated: {
    requireApproval: boolean;
    approvalMode: ApprovalMode;
    autoApproveMinScore: number;
    qualityMaxRegenerations: number;
  }) => void;
};

export function CampaignApprovalCard({
  campaignId,
  requireApproval = true,
  approvalMode = "MANUAL",
  autoApproveMinScore = 80,
  qualityMaxRegenerations = 2,
  onUpdated,
}: CampaignApprovalCardProps) {
  const [eligibility, setEligibility] = useState<AutoApprovalEligibility | null>(null);

  // Edit modal state
  const [isEditing, setIsEditing] = useState(false);
  const [editRequireApproval, setEditRequireApproval] = useState(requireApproval);
  const [editApprovalMode, setEditApprovalMode] = useState<ApprovalMode>(approvalMode);
  const [editMinScore, setEditMinScore] = useState(String(autoApproveMinScore));
  const [editMaxRegens, setEditMaxRegens] = useState(String(qualityMaxRegenerations));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickSwitching, setQuickSwitching] = useState(false);

  useEffect(() => {
    let ignore = false;
    getCampaignApprovalEligibility(campaignId)
      .then((res) => {
        if (!ignore) {
          setEligibility(res);
        }
      })
      .catch(() => {
        // Non-fatal if eligibility endpoint fails
      });

    return () => {
      ignore = true;
    };
  }, [campaignId]);

  const refreshEligibility = async () => {
    try {
      const res = await getCampaignApprovalEligibility(campaignId);
      setEligibility(res);
    } catch {
      // Non-fatal
    }
  };

  const handleOpenEdit = () => {
    setEditRequireApproval(requireApproval);
    setEditApprovalMode(approvalMode);
    setEditMinScore(String(autoApproveMinScore));
    setEditMaxRegens(String(qualityMaxRegenerations));
    setError(null);
    setIsEditing(true);
  };

  const handleQuickSwitchToManual = async () => {
    setQuickSwitching(true);
    setError(null);
    try {
      await updateCampaign(campaignId, { approvalMode: "MANUAL" });
      onUpdated?.({
        requireApproval,
        approvalMode: "MANUAL",
        autoApproveMinScore,
        qualityMaxRegenerations,
      });
      void refreshEligibility();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Failed to switch approval mode.");
      }
    } finally {
      setQuickSwitching(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedMinScore = parseInt(editMinScore.trim(), 10);
    if (isNaN(parsedMinScore) || parsedMinScore < 0 || parsedMinScore > 100) {
      setError("Auto-approve min score must be an integer between 0 and 100.");
      return;
    }

    const parsedMaxRegens = parseInt(editMaxRegens.trim(), 10);
    if (isNaN(parsedMaxRegens) || parsedMaxRegens < 0 || parsedMaxRegens > 5) {
      setError("Max regenerations must be an integer between 0 and 5.");
      return;
    }

    setIsSubmitting(true);
    try {
      const updated = await updateCampaign(campaignId, {
        requireApproval: editRequireApproval,
        approvalMode: editApprovalMode,
        autoApproveMinScore: parsedMinScore,
        qualityMaxRegenerations: parsedMaxRegens,
      });

      setIsEditing(false);

      onUpdated?.({
        requireApproval: updated.requireApproval,
        approvalMode: updated.approvalMode,
        autoApproveMinScore: updated.autoApproveMinScore,
        qualityMaxRegenerations: updated.qualityMaxRegenerations,
      });
      void refreshEligibility();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Failed to update approval settings.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 mt-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">Quality Gate & Approval Policy</h3>
            {approvalMode === "AUTO_ELIGIBLE" ? (
              eligibility?.eligible ? (
                <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                  ● Auto-Approve Active
                </span>
              ) : (
                <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                  ▲ Auto-Approve Pending Eligibility
                </span>
              )
            ) : (
              <span className="rounded-full bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
                ● Manual Review Mode
              </span>
            )}
            {!requireApproval && (
              <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-300">
                Approval Disabled
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Governs whether AI-generated outreach drafts must be approved manually before dispatching into Instagram threads.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {approvalMode === "AUTO_ELIGIBLE" && (
            <button
              type="button"
              id="switch-to-manual-btn"
              onClick={handleQuickSwitchToManual}
              disabled={quickSwitching}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition disabled:opacity-50"
            >
              {quickSwitching ? "Switching..." : "Switch to Manual Mode"}
            </button>
          )}
          <button
            type="button"
            id="edit-approval-settings-btn"
            onClick={handleOpenEdit}
            className="rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:text-white transition"
          >
            Edit Settings
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* Settings Grid */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 pt-3 border-t border-zinc-800/80">
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5">
          <div className="text-[10px] uppercase font-semibold text-zinc-500">Review Gate</div>
          <div className="mt-1 text-xs font-medium text-zinc-200">
            {requireApproval ? "Manual Gate Required" : "Auto-Send Direct"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5">
          <div className="text-[10px] uppercase font-semibold text-zinc-500">Configured Mode</div>
          <div className="mt-1 text-xs font-medium text-zinc-200">
            {approvalMode === "AUTO_ELIGIBLE" ? "AUTO_ELIGIBLE" : "MANUAL"}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5">
          <div className="text-[10px] uppercase font-semibold text-zinc-500">Auto-Approve Min Score</div>
          <div className="mt-1 text-xs font-medium text-zinc-200">
            ≥ {autoApproveMinScore} / 100
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-2.5">
          <div className="text-[10px] uppercase font-semibold text-zinc-500">Max Quality Regenerations</div>
          <div className="mt-1 text-xs font-medium text-zinc-200">
            {qualityMaxRegenerations} attempts
          </div>
        </div>
      </div>

      {/* Auto-Approval Eligibility Status Panel */}
      {eligibility && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">
              Live Auto-Approval Eligibility
            </span>
            <span
              id="eligibility-status-badge"
              className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                eligibility.eligible
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                  : "bg-amber-500/10 border border-amber-500/20 text-amber-300"
              }`}
            >
              {eligibility.eligible
                ? "Eligible — Auto-approving clean drafts"
                : `${eligibility.metrics.reviewed}/${eligibility.metrics.minReviewed} reviewed drafts — Not yet eligible`}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-[11px] text-zinc-400 pt-2 border-t border-zinc-800/60">
            <div>
              <span className="text-zinc-500">Human Reviews: </span>
              <span className={eligibility.metrics.reviewed >= eligibility.metrics.minReviewed ? "text-emerald-400 font-semibold" : "text-amber-400"}>
                {eligibility.metrics.reviewed} / {eligibility.metrics.minReviewed}
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Approval Rate: </span>
              <span className={eligibility.metrics.approvalRate >= eligibility.metrics.minApprovalRate ? "text-emerald-400 font-semibold" : "text-amber-400"}>
                {(eligibility.metrics.approvalRate * 100).toFixed(0)}% (min {(eligibility.metrics.minApprovalRate * 100).toFixed(0)}%)
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Edit Rate: </span>
              <span className={eligibility.metrics.editRate <= eligibility.metrics.maxEditRate ? "text-emerald-400 font-semibold" : "text-amber-400"}>
                {(eligibility.metrics.editRate * 100).toFixed(0)}% (max {(eligibility.metrics.maxEditRate * 100).toFixed(0)}%)
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Kill Switch: </span>
              <span className={eligibility.metrics.enabled ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
                {eligibility.metrics.enabled ? "Enabled" : "Disabled (AUTO_APPROVAL_ENABLED)"}
              </span>
            </div>
          </div>

          {eligibility.unmet.length > 0 && approvalMode === "AUTO_ELIGIBLE" && (
            <div className="text-[11px] text-amber-400/90 pt-1">
              <span className="font-semibold">Unmet criteria: </span>
              {eligibility.unmet.join("; ")}
            </div>
          )}
        </div>
      )}

      {/* Edit Settings Modal */}
      {isEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100">Edit Campaign Approval Policy</h3>
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="text-zinc-400 hover:text-zinc-200 text-sm"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              {error && (
                <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div>
                  <label htmlFor="edit-require-approval" className="text-xs font-medium text-zinc-200 cursor-pointer">
                    Require manual approval
                  </label>
                  <p className="text-[11px] text-zinc-500">
                    When active, drafts must be approved before outbound sending.
                  </p>
                </div>
                <input
                  id="edit-require-approval"
                  type="checkbox"
                  checked={editRequireApproval}
                  onChange={(e) => setEditRequireApproval(e.target.checked)}
                  disabled={isSubmitting}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-rose-600 focus:ring-rose-500 cursor-pointer"
                />
              </div>

              <div>
                <label htmlFor="edit-approval-mode" className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                  Approval Mode
                </label>
                <select
                  id="edit-approval-mode"
                  value={editApprovalMode}
                  onChange={(e) => setEditApprovalMode(e.target.value as ApprovalMode)}
                  disabled={isSubmitting}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                >
                  <option value="MANUAL">MANUAL (Human review required for all drafts)</option>
                  <option value="AUTO_ELIGIBLE">AUTO_ELIGIBLE (Auto-approve clean drafts if eligible)</option>
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Switching to AUTO_ELIGIBLE requires ≥200 reviewed drafts, ≥80% approval rate, and ≤30% edit rate.
                </p>
              </div>

              {editApprovalMode === "AUTO_ELIGIBLE" && eligibility && !eligibility.eligible && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-[11px] text-amber-300 space-y-1">
                  <div className="font-semibold">⚠ Cannot switch to AUTO_ELIGIBLE yet</div>
                  <div className="text-[10px] text-amber-200/90 leading-relaxed">
                    The backend strictly requires meeting all eligibility criteria before saving AUTO_ELIGIBLE mode. Current unmet: {eligibility.unmet.join("; ")}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="edit-auto-approve-min-score" className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                    Auto-Approve Min Score (0-100)
                  </label>
                  <input
                    id="edit-auto-approve-min-score"
                    type="number"
                    min={0}
                    max={100}
                    value={editMinScore}
                    onChange={(e) => setEditMinScore(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[10px] text-zinc-500">Drafts below this score still require review.</p>
                </div>

                <div>
                  <label htmlFor="edit-quality-max-regens" className="block text-[11px] font-semibold uppercase text-zinc-400 mb-1">
                    Max Regenerations (0-5)
                  </label>
                  <input
                    id="edit-quality-max-regens"
                    type="number"
                    min={0}
                    max={5}
                    value={editMaxRegens}
                    onChange={(e) => setEditMaxRegens(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                  />
                  <p className="mt-0.5 text-[10px] text-zinc-500">Auto-regeneration retry cap on quality warnings.</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  disabled={isSubmitting}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="save-approval-settings-btn"
                  disabled={isSubmitting}
                  className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 transition disabled:opacity-50"
                >
                  {isSubmitting ? "Saving..." : "Save Settings"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
