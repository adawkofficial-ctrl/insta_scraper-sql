"use client";

import { useEffect, useState } from "react";
import { updateCampaign, type CampaignSummary } from "@/lib/api/campaigns";
import {
  listCompanyProfiles,
  type CompanyProfilesListItem,
} from "@/lib/api/company-profile";
import { ApiClientError } from "@/lib/api/client";
import { MAX_CAMPAIGN_LEAD_LIMIT } from "@/lib/constants/campaign-limits";

export type EditCampaignModalProps = {
  isOpen: boolean;
  onClose: () => void;
  campaign: {
    id: string;
    name: string;
    description?: string | null;
    intent?: string | null;
    location?: string | null;
    category?: string | null;
    leadLimit?: number | null;
    companyProfileId?: string;
    companyProfile?: {
      id: string;
      name: string;
      description?: string | null;
      isDefault?: boolean;
    } | null;
    requireApproval?: boolean;
    approvalMode?: "MANUAL" | "AUTO_ELIGIBLE";
    autoApproveMinScore?: number;
    qualityMaxRegenerations?: number;
    followUpEnabled?: boolean;
    followUpCount?: number;
    followUpDelayDays?: number[];
    followUpTemplates?: string[];
    status?: string;
  } | null;
  onUpdated?: (updated: CampaignSummary) => void;
};

export function EditCampaignModal({
  isOpen,
  onClose,
  campaign,
  onUpdated,
}: EditCampaignModalProps) {
  if (!isOpen || !campaign) return null;

  return (
    <EditCampaignDialog
      key={campaign.id}
      campaign={campaign}
      onClose={onClose}
      onUpdated={onUpdated}
    />
  );
}

function EditCampaignDialog({
  campaign,
  onClose,
  onUpdated,
}: {
  campaign: NonNullable<EditCampaignModalProps["campaign"]>;
  onClose: () => void;
  onUpdated?: (updated: CampaignSummary) => void;
}) {
  const [name, setName] = useState(campaign.name || "");
  const [description, setDescription] = useState(campaign.description || "");
  const [intent, setIntent] = useState(campaign.intent || "");
  const [location, setLocation] = useState(campaign.location || "");
  const [category, setCategory] = useState(campaign.category || "");
  const [leadLimit, setLeadLimit] = useState(
    campaign.leadLimit != null ? String(campaign.leadLimit) : "",
  );

  // Company profile selection state
  const [profiles, setProfiles] = useState<CompanyProfilesListItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    campaign.companyProfileId || "",
  );

  // Approval settings state
  const [requireApproval, setRequireApproval] = useState(
    campaign.requireApproval ?? true,
  );
  const [showApprovalOptions, setShowApprovalOptions] = useState(
    campaign.approvalMode === "AUTO_ELIGIBLE",
  );
  const [approvalMode, setApprovalMode] = useState<"MANUAL" | "AUTO_ELIGIBLE">(
    campaign.approvalMode ?? "MANUAL",
  );
  const [autoApproveMinScore, setAutoApproveMinScore] = useState(
    campaign.autoApproveMinScore != null
      ? String(campaign.autoApproveMinScore)
      : "80",
  );
  const [qualityMaxRegenerations, setQualityMaxRegenerations] = useState(
    campaign.qualityMaxRegenerations != null
      ? String(campaign.qualityMaxRegenerations)
      : "2",
  );

  // Follow-up state
  const [followUpEnabled, setFollowUpEnabled] = useState(
    campaign.followUpEnabled ?? false,
  );
  const [followUpCount, setFollowUpCount] = useState<number>(
    campaign.followUpCount ?? 1,
  );
  const [delayDay1, setDelayDay1] = useState(
    String(campaign.followUpDelayDays?.[0] ?? 3),
  );
  const [delayDay2, setDelayDay2] = useState(
    String(campaign.followUpDelayDays?.[1] ?? 5),
  );
  const [template1, setTemplate1] = useState(
    campaign.followUpTemplates?.[0] ||
      "Hi {firstName}, following up on my previous message!",
  );
  const [template2, setTemplate2] = useState(
    campaign.followUpTemplates?.[1] ||
      "Hi {firstName}, just wanted to check in one last time!",
  );

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load available company profiles
  useEffect(() => {
    let ignore = false;

    listCompanyProfiles()
      .then((res) => {
        if (!ignore) {
          const items = res.profiles || [];
          setProfiles(items);
          // If no profile was pre-selected and default exists, select it
          if (!selectedProfileId && items.length > 0) {
            const defaultItem =
              items.find((i) => i.profile.isDefault) || items[0];
            setSelectedProfileId(defaultItem.profile.id);
          }
        }
      })
      .catch((err) => {
        if (!ignore) {
          console.error("Failed to load company profiles:", err);
        }
      })
      .finally(() => {
        if (!ignore) setLoadingProfiles(false);
      });

    return () => {
      ignore = true;
    };
  }, [selectedProfileId]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Campaign name is required.");
      return;
    }

    let parsedLeadLimit: number | null = null;
    if (leadLimit.trim()) {
      parsedLeadLimit = parseInt(leadLimit.trim(), 10);
      if (
        isNaN(parsedLeadLimit) ||
        parsedLeadLimit < 1 ||
        parsedLeadLimit > MAX_CAMPAIGN_LEAD_LIMIT
      ) {
        setError("Lead limit must be a positive whole number.");
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const parsedMinScore = parseInt(autoApproveMinScore.trim() || "80", 10);
      const parsedRegens = parseInt(qualityMaxRegenerations.trim() || "2", 10);

      const updated = await updateCampaign(campaign.id, {
        name: trimmedName,
        description: description.trim() || null,
        intent: intent.trim() || null,
        location: location.trim() || null,
        category: category.trim() || null,
        leadLimit: parsedLeadLimit,
        companyProfileId: selectedProfileId || undefined,
        requireApproval,
        approvalMode,
        autoApproveMinScore: isNaN(parsedMinScore) ? 80 : parsedMinScore,
        qualityMaxRegenerations: isNaN(parsedRegens) ? 2 : parsedRegens,
        followUpEnabled,
        followUpCount: followUpEnabled ? followUpCount : 0,
        followUpDelayDays: [parseInt(delayDay1, 10) || 3, parseInt(delayDay2, 10) || 5],
        followUpTemplates: followUpCount === 2 ? [template1, template2] : [template1],
      });

      onUpdated?.(updated);
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Failed to update campaign. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedItem = profiles.find((p) => p.profile.id === selectedProfileId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/80 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">
                Edit Campaign
              </h2>
              <p className="text-xs text-zinc-400">
                Update audience targeting, discovery intent & execution settings
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Campaign Name */}
          <div>
            <label
              htmlFor="edit-campaign-name"
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-300"
            >
              Campaign Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="edit-campaign-name"
              type="text"
              required
              disabled={isSubmitting}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Toronto Dental Practices"
              className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="edit-campaign-desc"
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-300"
            >
              Description <span className="text-zinc-500">(optional)</span>
            </label>
            <textarea
              id="edit-campaign-desc"
              rows={2}
              disabled={isSubmitting}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe target audience, niche, or campaign goals..."
              className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Attached Company Profile */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <span className="h-2 w-2 rounded-full bg-purple-500" />
                <span>Company Profile Context</span>
              </div>
              <span className="text-[11px] text-zinc-400">
                Used by Gemini AI for tone & quality gate
              </span>
            </div>

            {loadingProfiles ? (
              <div className="py-2 text-xs text-zinc-500 italic">
                Loading company profiles...
              </div>
            ) : profiles.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-400">
                No company profiles found. You can configure one in Settings.
              </div>
            ) : (
              <div>
                <select
                  value={selectedProfileId}
                  onChange={(e) => setSelectedProfileId(e.target.value)}
                  disabled={isSubmitting}
                  className="block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  {profiles.map((item) => (
                    <option key={item.profile.id} value={item.profile.id}>
                      {item.profile.name}
                      {item.profile.isDefault ? " (Default)" : ""}
                    </option>
                  ))}
                </select>
                {selectedItem && (
                  <p className="mt-1.5 text-[11px] text-zinc-400 line-clamp-1">
                    {selectedItem.profile.description}
                  </p>
                )}
              </div>
            )}

            {/* Follow-up Message Settings */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <label className="text-xs font-semibold text-zinc-200">
                    Scheduled Follow-up DMs
                  </label>
                  <p className="text-[11px] text-zinc-400">
                    Automatically send scheduled follow-ups to leads who have not replied.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={followUpEnabled}
                  onChange={(e) => setFollowUpEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500"
                />
              </div>

              {followUpEnabled && (
                <div className="space-y-4 pt-2 border-t border-zinc-800/80">
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-300 mb-1.5">
                      Number of Follow-ups
                    </label>
                    <div className="flex items-center gap-4 text-xs">
                      <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                        <input
                          type="radio"
                          name="followUpCount"
                          value={1}
                          checked={followUpCount === 1}
                          onChange={() => setFollowUpCount(1)}
                          className="text-indigo-600"
                        />
                        <span>1 Follow-up</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                        <input
                          type="radio"
                          name="followUpCount"
                          value={2}
                          checked={followUpCount === 2}
                          onChange={() => setFollowUpCount(2)}
                          className="text-indigo-600"
                        />
                        <span>2 Follow-ups</span>
                      </label>
                    </div>
                  </div>

                  {/* Follow-up #1 */}
                  <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-zinc-200">
                        Follow-up #1
                      </span>
                      <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                        <span>Delay:</span>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          value={delayDay1}
                          onChange={(e) => setDelayDay1(e.target.value)}
                          className="w-14 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-100"
                        />
                        <span>days</span>
                      </div>
                    </div>
                    <div>
                      <textarea
                        rows={2}
                        value={template1}
                        onChange={(e) => setTemplate1(e.target.value)}
                        placeholder="Hi {firstName}, following up on my previous message!"
                        className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-100 placeholder-zinc-500"
                      />
                      <p className="text-[10px] text-zinc-500 mt-0.5">
                        Placeholders: {"{firstName}"}, {"{businessName}"}, {"{city}"}
                      </p>
                    </div>
                  </div>

                  {/* Follow-up #2 */}
                  {followUpCount === 2 && (
                    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-zinc-200">
                          Follow-up #2
                        </span>
                        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                          <span>Delay:</span>
                          <input
                            type="number"
                            min={1}
                            max={60}
                            value={delayDay2}
                            onChange={(e) => setDelayDay2(e.target.value)}
                            className="w-14 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-100"
                          />
                          <span>days</span>
                        </div>
                      </div>
                      <div>
                        <textarea
                          rows={2}
                          value={template2}
                          onChange={(e) => setTemplate2(e.target.value)}
                          placeholder="Hi {firstName}, just wanted to check in one last time!"
                          className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-100 placeholder-zinc-500"
                        />
                        <p className="text-[10px] text-zinc-500 mt-0.5">
                          Must differ from Follow-up #1 and initial message.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Target Audience & Discovery Parameters */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                <span>Discovery & Targeting Parameters</span>
              </div>
              <span className="text-[11px] text-zinc-400">
                Used for Google Maps & Instagram search
              </span>
            </div>

            {/* Intent / Keywords */}
            <div>
              <label
                htmlFor="edit-campaign-intent"
                className="block text-[11px] font-semibold uppercase text-zinc-400"
              >
                Intent / Keywords
              </label>
              <input
                id="edit-campaign-intent"
                type="text"
                disabled={isSubmitting}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. dental clinics, cosmetic dentistry practices"
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Clean search terms used to find real operating local businesses.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Location */}
              <div>
                <label
                  htmlFor="edit-campaign-location"
                  className="block text-[11px] font-semibold uppercase text-zinc-400"
                >
                  Location
                </label>
                <input
                  id="edit-campaign-location"
                  type="text"
                  disabled={isSubmitting}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Toronto, Vancouver"
                  className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Multiple cities allowed (comma-separated).
                </p>
              </div>

              {/* Category */}
              <div>
                <label
                  htmlFor="edit-campaign-category"
                  className="block text-[11px] font-semibold uppercase text-zinc-400"
                >
                  Category
                </label>
                <input
                  id="edit-campaign-category"
                  type="text"
                  disabled={isSubmitting}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Dental, Fitness, Healthcare"
                  className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Business category for validation gates.
                </p>
              </div>
            </div>

            {/* Lead Limit */}
            <div>
              <label
                htmlFor="edit-campaign-limit"
                className="block text-[11px] font-semibold uppercase text-zinc-400"
              >
                Lead Limit
              </label>
              <input
                id="edit-campaign-limit"
                type="number"
                min={1}
                disabled={isSubmitting}
                value={leadLimit}
                onChange={(e) => setLeadLimit(e.target.value)}
                placeholder="e.g. 1000"
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Maximum qualified leads to persist in this campaign.
              </p>
            </div>
          </div>

          {/* Message Approval & Quality Gates */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-zinc-200">
                  Message Approval & Quality Gates
                </span>
                <p className="text-[11px] text-zinc-400">
                  Control whether messages must be reviewed before sending
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.target.checked)}
                  disabled={isSubmitting}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            {requireApproval && (
              <div className="pt-2 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => setShowApprovalOptions(!showApprovalOptions)}
                  className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  <svg
                    className={`h-3.5 w-3.5 transition-transform ${showApprovalOptions ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span>
                    {showApprovalOptions
                      ? "Hide Advanced Gate Settings"
                      : "Configure Auto-Approval & Quality Thresholds"}
                  </span>
                </button>

                {showApprovalOptions && (
                  <div className="mt-3 space-y-3 pl-2 border-l border-zinc-800">
                    <div className="space-y-1.5">
                      <label className="block text-[11px] font-semibold text-zinc-300">
                        Approval Mode
                      </label>
                      <div className="flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                          <input
                            type="radio"
                            name="editApprovalMode"
                            value="MANUAL"
                            checked={approvalMode === "MANUAL"}
                            onChange={() => setApprovalMode("MANUAL")}
                            className="text-indigo-600"
                          />
                          <span>Strict Manual (Always review)</span>
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer text-zinc-300">
                          <input
                            type="radio"
                            name="editApprovalMode"
                            value="AUTO_ELIGIBLE"
                            checked={approvalMode === "AUTO_ELIGIBLE"}
                            onChange={() => setApprovalMode("AUTO_ELIGIBLE")}
                            className="text-indigo-600"
                          />
                          <span>Auto-Approve High Scoring</span>
                        </label>
                      </div>
                    </div>

                    {approvalMode === "AUTO_ELIGIBLE" && (
                      <div className="grid grid-cols-2 gap-3 pt-1">
                        <div>
                          <label className="block text-[11px] font-semibold text-zinc-400">
                            Min Quality Score (0-100)
                          </label>
                          <input
                            type="number"
                            min={50}
                            max={100}
                            value={autoApproveMinScore}
                            onChange={(e) =>
                              setAutoApproveMinScore(e.target.value)
                            }
                            className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-zinc-400">
                            Max Regenerations
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            value={qualityMaxRegenerations}
                            onChange={(e) =>
                              setQualityMaxRegenerations(e.target.value)
                            }
                            className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:from-rose-500 hover:to-indigo-500 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <svg
                    className="h-3.5 w-3.5 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
