"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createCampaign } from "@/lib/api/campaigns";
import {
  createCompanyProfile,
  listCompanyProfiles,
  type CompanyProfileInput,
  type CompanyProfilesListItem,
} from "@/lib/api/company-profile";
import { ApiClientError } from "@/lib/api/client";
import { MAX_CAMPAIGN_LEAD_LIMIT } from "@/lib/constants/campaign-limits";

type CreateCampaignModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
};

type InlineProfileForm = {
  name: string;
  description: string;
  servicesText: string;
  targetIndustriesText: string;
  targetCountriesText: string;
  brandTone: string;
  messageLanguage: string;
  minWords: string;
  maxWords: string;
  ctaStyle: string;
  forbiddenClaimsText: string;
  pricingPolicy: string;
  idealCustomerProfile: string;
  exampleMessagesText: string;
  objectionNotes: string;
};

const EMPTY_INLINE_PROFILE: InlineProfileForm = {
  name: "",
  description: "",
  servicesText: "",
  targetIndustriesText: "",
  targetCountriesText: "",
  brandTone: "",
  messageLanguage: "en",
  minWords: "10",
  maxWords: "60",
  ctaStyle: "",
  forbiddenClaimsText: "",
  pricingPolicy: "",
  idealCustomerProfile: "",
  exampleMessagesText: "",
  objectionNotes: "",
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function CreateCampaignModal({
  isOpen,
  onClose,
  onCreated,
}: CreateCampaignModalProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [intent, setIntent] = useState("");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState("");
  const [leadLimit, setLeadLimit] = useState("");

  // Company profile selection state
  const [profiles, setProfiles] = useState<CompanyProfilesListItem[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [profileMode, setProfileMode] = useState<"select" | "create">("select");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [inlineProfile, setInlineProfile] = useState<InlineProfileForm>(EMPTY_INLINE_PROFILE);

  // Approval settings state
  const [requireApproval, setRequireApproval] = useState(true);
  const [showApprovalOptions, setShowApprovalOptions] = useState(false);
  const [approvalMode, setApprovalMode] = useState<"MANUAL" | "AUTO_ELIGIBLE">("MANUAL");
  const [autoApproveMinScore, setAutoApproveMinScore] = useState("80");
  const [qualityMaxRegenerations, setQualityMaxRegenerations] = useState("2");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;
    const timer = setTimeout(() => {
      if (!ignore) setLoadingProfiles(true);
    }, 0);
    listCompanyProfiles()
      .then((res) => {
        if (ignore) return;
        setProfiles(res.profiles);
        if (res.profiles.length > 0) {
          const defaultProf = res.profiles.find((p) => p.profile.isDefault);
          setSelectedProfileId(defaultProf ? defaultProf.profile.id : res.profiles[0].profile.id);
          setProfileMode("select");
        } else {
          setProfileMode("create");
        }
      })
      .catch(() => {
        if (!ignore) setError("Could not load company profiles.");
      })
      .finally(() => {
        if (!ignore) setLoadingProfiles(false);
      });

    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const setInline = (key: keyof InlineProfileForm) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setInlineProfile((prev) => ({ ...prev, [key]: event.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError("Campaign name is required.");
      return;
    }

    let parsedLeadLimit: number | null = null;
    if (leadLimit.trim()) {
      const parsed = parseInt(leadLimit.trim(), 10);
      if (isNaN(parsed) || parsed < 1 || parsed > MAX_CAMPAIGN_LEAD_LIMIT) {
        setError("Lead limit must be a positive whole number.");
        return;
      }
      parsedLeadLimit = parsed;
    }

    let finalProfileId = selectedProfileId;

    if (profileMode === "create") {
      if (!inlineProfile.name.trim()) {
        setError("Company profile name is required.");
        return;
      }
    } else if (!finalProfileId) {
      setError("Please select a company profile or create a new one.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (profileMode === "create") {
        const min = Number(inlineProfile.minWords);
        const max = Number(inlineProfile.maxWords);
        const preferredLength =
          Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min
            ? { minWords: min, maxWords: max }
            : null;

        const services = splitLines(inlineProfile.servicesText).map((entry) => {
          const [sname, svalue] = entry.split(/\s+—\s+|\s+-\s+/);
          return svalue ? { name: sname.trim(), value: svalue.trim() } : { name: entry.trim() };
        });

        const profileInput: CompanyProfileInput = {
          name: inlineProfile.name.trim(),
          description: inlineProfile.description.trim(),
          services,
          targetIndustries: splitLines(inlineProfile.targetIndustriesText),
          targetCountries: splitLines(inlineProfile.targetCountriesText),
          idealCustomerProfile: inlineProfile.idealCustomerProfile.trim() || null,
          brandTone: inlineProfile.brandTone.trim() || null,
          messageLanguage: inlineProfile.messageLanguage.trim() || "en",
          preferredLength,
          ctaStyle: inlineProfile.ctaStyle.trim() || null,
          forbiddenClaims: splitLines(inlineProfile.forbiddenClaimsText),
          pricingPolicy: inlineProfile.pricingPolicy.trim() || null,
          exampleMessages: splitLines(inlineProfile.exampleMessagesText),
          objectionNotes: inlineProfile.objectionNotes.trim() || null,
        };

        const createdProfileRes = await createCompanyProfile(profileInput);
        finalProfileId = createdProfileRes.profile?.id || "";
      }

      const parsedMinScore = parseInt(autoApproveMinScore.trim() || "80", 10);
      const parsedRegens = parseInt(qualityMaxRegenerations.trim() || "2", 10);

      const campaign = await createCampaign({
        name: trimmedName,
        description: description.trim() || null,
        intent: intent.trim() || null,
        location: location.trim() || null,
        category: category.trim() || null,
        leadLimit: parsedLeadLimit,
        companyProfileId: finalProfileId,
        requireApproval,
        approvalMode,
        autoApproveMinScore: isNaN(parsedMinScore) ? 80 : parsedMinScore,
        qualityMaxRegenerations: isNaN(parsedRegens) ? 2 : parsedRegens,
      });

      setName("");
      setDescription("");
      setIntent("");
      setLocation("");
      setCategory("");
      setLeadLimit("");
      setRequireApproval(true);
      setShowApprovalOptions(false);
      setApprovalMode("MANUAL");
      setAutoApproveMinScore("80");
      setQualityMaxRegenerations("2");
      setInlineProfile(EMPTY_INLINE_PROFILE);
      onClose();
      if (onCreated) {
        onCreated();
      }
      router.push(`/campaigns/${campaign.id}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Failed to create campaign. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedItem = profiles.find((p) => p.profile.id === selectedProfileId);

  const inputClass =
    "mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50";
  const labelClass = "block text-[11px] font-semibold uppercase text-zinc-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-xs transition-opacity"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/80 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Create New Campaign</h2>
              <p className="text-xs text-zinc-400">Configure target audience, company profile & outreach</p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="campaign-name" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Campaign Name <span className="text-rose-400">*</span>
            </label>
            <input
              id="campaign-name"
              type="text"
              required
              disabled={isSubmitting}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rawalpindi Fitness Campaign"
              className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="campaign-desc" className="block text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Description <span className="text-zinc-500">(optional)</span>
            </label>
            <textarea
              id="campaign-desc"
              rows={2}
              disabled={isSubmitting}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe target audience, niche, or campaign goals..."
              className="mt-1.5 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
            />
          </div>

          {/* Company Profile Selection / Creation Section */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <span className="h-2 w-2 rounded-full bg-indigo-500" />
                <span>Company Profile Context <span className="text-rose-400">*</span></span>
              </div>
              <span className="text-[11px] text-zinc-400">Used by Gemini AI for tone & quality gate</span>
            </div>

            <div className="flex items-center gap-4 text-xs pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                <input
                  type="radio"
                  name="profileMode"
                  value="select"
                  checked={profileMode === "select"}
                  onChange={() => setProfileMode("select")}
                  disabled={profiles.length === 0 || isSubmitting}
                  className="text-rose-500 focus:ring-rose-500"
                />
                <span>Select existing profile ({profiles.length})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
                <input
                  type="radio"
                  name="profileMode"
                  value="create"
                  checked={profileMode === "create"}
                  onChange={() => setProfileMode("create")}
                  disabled={isSubmitting}
                  className="text-rose-500 focus:ring-rose-500"
                />
                <span>Create new profile for this campaign</span>
              </label>
            </div>

            {profileMode === "select" ? (
              <div className="space-y-2 pt-1">
                {loadingProfiles ? (
                  <p className="text-xs text-zinc-500">Loading company profiles...</p>
                ) : profiles.length === 0 ? (
                  <p className="text-xs text-amber-300">
                    No existing profiles found. Please create one below.
                  </p>
                ) : (
                  <>
                    <select
                      id="campaign-profile-select"
                      disabled={isSubmitting}
                      value={selectedProfileId}
                      onChange={(e) => setSelectedProfileId(e.target.value)}
                      className="block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                    >
                      {profiles.map(({ profile, completeness }) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} — {completeness.complete ? "✓ Ready for AI" : `⚠ Incomplete (${completeness.missingFields.length} missing)`}
                          {profile.isDefault ? " [Default]" : ""}
                        </option>
                      ))}
                    </select>

                    {selectedItem && (
                      <div className="flex items-center justify-between text-[11px] text-zinc-400 px-1 pt-1">
                        <span>
                          {selectedItem.profile.services.length} services • {selectedItem.profile.targetIndustries.join(", ") || "No industries"}
                        </span>
                        {selectedItem.completeness.complete ? (
                          <span className="text-emerald-400 font-medium">Ready for AI</span>
                        ) : (
                          <span className="text-amber-400 font-medium">
                            Missing: {selectedItem.completeness.missingFields.join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              /* Inline Profile Creation Form */
              <div className="space-y-3 pt-2 border-t border-zinc-800">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-name">
                      Profile Label *
                    </label>
                    <input
                      id="inline-cp-name"
                      className={inputClass}
                      value={inlineProfile.name}
                      onChange={setInline("name")}
                      placeholder="e.g. Fitness Studios Offer"
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-language">
                      Language *
                    </label>
                    <input
                      id="inline-cp-language"
                      className={inputClass}
                      value={inlineProfile.messageLanguage}
                      onChange={setInline("messageLanguage")}
                      placeholder="en"
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass} htmlFor="inline-cp-description">
                    Company Description *
                  </label>
                  <textarea
                    id="inline-cp-description"
                    rows={2}
                    className={inputClass}
                    value={inlineProfile.description}
                    onChange={setInline("description")}
                    placeholder="We provide appointment scheduling software for gyms."
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor="inline-cp-services">
                    Services / Products * (one per line)
                  </label>
                  <textarea
                    id="inline-cp-services"
                    rows={2}
                    className={inputClass}
                    value={inlineProfile.servicesText}
                    onChange={setInline("servicesText")}
                    placeholder="Booking Software&#10;Lead Recall Automation"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-industries">
                      Target Industries * (comma separated)
                    </label>
                    <input
                      id="inline-cp-industries"
                      className={inputClass}
                      value={inlineProfile.targetIndustriesText}
                      onChange={setInline("targetIndustriesText")}
                      placeholder="fitness, gyms, crossfit"
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-tone">
                      Brand Tone *
                    </label>
                    <input
                      id="inline-cp-tone"
                      className={inputClass}
                      value={inlineProfile.brandTone}
                      onChange={setInline("brandTone")}
                      placeholder="friendly, direct"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-cta">
                      CTA Style *
                    </label>
                    <input
                      id="inline-cp-cta"
                      className={inputClass}
                      value={inlineProfile.ctaStyle}
                      onChange={setInline("ctaStyle")}
                      placeholder="soft question"
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-min">
                      Min Words *
                    </label>
                    <input
                      id="inline-cp-min"
                      type="number"
                      className={inputClass}
                      value={inlineProfile.minWords}
                      onChange={setInline("minWords")}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="inline-cp-max">
                      Max Words *
                    </label>
                    <input
                      id="inline-cp-max"
                      type="number"
                      className={inputClass}
                      value={inlineProfile.maxWords}
                      onChange={setInline("maxWords")}
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass} htmlFor="inline-cp-pricing">
                    Pricing Policy *
                  </label>
                  <input
                    id="inline-cp-pricing"
                    className={inputClass}
                    value={inlineProfile.pricingPolicy}
                    onChange={setInline("pricingPolicy")}
                    placeholder="do not share price in first DM"
                  />
                </div>

                <div>
                  <label className={labelClass} htmlFor="inline-cp-forbidden">
                    Forbidden Claims (comma separated)
                  </label>
                  <input
                    id="inline-cp-forbidden"
                    className={inputClass}
                    value={inlineProfile.forbiddenClaimsText}
                    onChange={setInline("forbiddenClaimsText")}
                    placeholder="guaranteed, 100% free"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Discovery / Intent Configuration */}
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5 space-y-3">
            <div className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              <span>Discovery & Intent Settings</span>
            </div>

            <div>
              <label htmlFor="campaign-intent" className="block text-[11px] font-medium text-zinc-400">
                Intent / Keywords <span className="text-zinc-500">(e.g. fitness gyms and fitness businesses)</span>
              </label>
              <input
                id="campaign-intent"
                type="text"
                disabled={isSubmitting}
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. fitness gyms and fitness businesses"
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="campaign-location" className="block text-[11px] font-medium text-zinc-400">
                  Location <span className="text-zinc-500">(one or more cities, comma-separated)</span>
                </label>
                <input
                  id="campaign-location"
                  type="text"
                  disabled={isSubmitting}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Toronto, ON, Vancouver, BC"
                  className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor="campaign-category" className="block text-[11px] font-medium text-zinc-400">
                  Category <span className="text-zinc-500">(e.g. Fitness)</span>
                </label>
                <input
                  id="campaign-category"
                  type="text"
                  disabled={isSubmitting}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Fitness"
                  className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
                />
              </div>
            </div>

            <div>
              <label htmlFor="campaign-lead-limit" className="block text-[11px] font-medium text-zinc-400">
                Lead Limit <span className="text-zinc-500">(max leads per run)</span>
              </label>
              <input
                id="campaign-lead-limit"
                type="number"
                min={1}
                disabled={isSubmitting}
                value={leadLimit}
                onChange={(e) => setLeadLimit(e.target.value)}
                placeholder="e.g. 10"
                className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500 disabled:opacity-50"
              />
            </div>

            {/* Approval Settings */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="campaign-require-approval" className="text-xs font-semibold text-zinc-200 cursor-pointer">
                    Require manual approval before sending
                  </label>
                  <p className="text-[11px] text-zinc-500">
                    Drafts will be routed to the Review Queue before outbound dispatch.
                  </p>
                </div>
                <input
                  id="campaign-require-approval"
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.target.checked)}
                  disabled={isSubmitting}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-rose-600 focus:ring-rose-500 focus:ring-offset-zinc-900 cursor-pointer"
                />
              </div>

              <div className="pt-2 border-t border-zinc-800/60">
                <button
                  type="button"
                  id="toggle-approval-options-btn"
                  onClick={() => setShowApprovalOptions((prev) => !prev)}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
                >
                  <span>{showApprovalOptions ? "▾ Hide approval options" : "▸ Show approval options"}</span>
                  <span className="text-[10px] text-zinc-500">({approvalMode === "AUTO_ELIGIBLE" ? "Auto-Eligible" : "Manual mode"})</span>
                </button>

                {showApprovalOptions && (
                  <div className="mt-3 space-y-3 pl-2 border-l-2 border-zinc-800">
                    <div>
                      <label htmlFor="campaign-approval-mode" className="block text-[11px] font-medium text-zinc-400">
                        Approval Mode
                      </label>
                      <select
                        id="campaign-approval-mode"
                        value={approvalMode}
                        onChange={(e) => setApprovalMode(e.target.value as "MANUAL" | "AUTO_ELIGIBLE")}
                        disabled={isSubmitting}
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none"
                      >
                        <option value="MANUAL">MANUAL (Default — human reviews every draft)</option>
                        <option value="AUTO_ELIGIBLE">AUTO_ELIGIBLE (Auto-approves clean drafts once eligible)</option>
                      </select>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        {approvalMode === "MANUAL"
                          ? "Every generated draft requires explicit human review and approval."
                          : "Auto-approves clean drafts once this campaign has enough reviewed history — can be changed later."}
                      </p>
                    </div>

                    {approvalMode === "AUTO_ELIGIBLE" && (
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-[11px] text-amber-300 space-y-1">
                        <div className="font-semibold flex items-center gap-1.5">
                          <span>ℹ</span>
                          <span>Eligibility required before activation</span>
                        </div>
                        <p className="text-amber-200/80 text-[10px] leading-relaxed">
                          Brand-new campaigns start with 0 human reviews. Auto-approval will only take effect once this campaign accumulates at least 200 reviewed drafts with ≥80% approval rate and ≤30% edit rate. Until then, drafts will require manual review.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor="campaign-auto-approve-min-score" className="block text-[11px] font-medium text-zinc-400">
                          Auto-Approve Min Score (0-100)
                        </label>
                        <input
                          id="campaign-auto-approve-min-score"
                          type="number"
                          min={0}
                          max={100}
                          value={autoApproveMinScore}
                          onChange={(e) => setAutoApproveMinScore(e.target.value)}
                          disabled={isSubmitting || approvalMode !== "AUTO_ELIGIBLE"}
                          placeholder="80"
                          className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none disabled:opacity-40"
                        />
                        <p className="mt-0.5 text-[10px] text-zinc-500">
                          Minimum quality score required for auto-approval (default 80).
                        </p>
                      </div>

                      <div>
                        <label htmlFor="campaign-quality-max-regens" className="block text-[11px] font-medium text-zinc-400">
                          Max Regenerations (0-5)
                        </label>
                        <input
                          id="campaign-quality-max-regens"
                          type="number"
                          min={0}
                          max={5}
                          value={qualityMaxRegenerations}
                          onChange={(e) => setQualityMaxRegenerations(e.target.value)}
                          disabled={isSubmitting}
                          placeholder="2"
                          className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 focus:border-rose-500 focus:outline-none disabled:opacity-40"
                        />
                        <p className="mt-0.5 text-[10px] text-zinc-500">
                          Max automatic re-draft attempts if quality check flags issues (default 2).
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={onClose}
              className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              id="submit-campaign-btn"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <svg className="h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>Creating Campaign...</span>
                </>
              ) : (
                <span>Create Campaign</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
