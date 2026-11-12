"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createCompanyProfile,
  deleteCompanyProfile,
  listCompanyProfiles,
  updateCompanyProfile,
  type CompanyProfileCompleteness,
  type CompanyProfileInput,
  type CompanyProfilesListItem,
} from "@/lib/api/company-profile";
import { ApiClientError } from "@/lib/api/client";

type FormState = {
  name: string;
  isDefault: boolean;
  description: string;
  servicesText: string;
  targetIndustriesText: string;
  targetCountriesText: string;
  idealCustomerProfile: string;
  brandTone: string;
  messageLanguage: string;
  minWords: string;
  maxWords: string;
  ctaStyle: string;
  forbiddenClaimsText: string;
  pricingPolicy: string;
  exampleMessagesText: string;
  objectionNotes: string;
};

const EMPTY: FormState = {
  name: "",
  isDefault: false,
  description: "",
  servicesText: "",
  targetIndustriesText: "",
  targetCountriesText: "",
  idealCustomerProfile: "",
  brandTone: "",
  messageLanguage: "en",
  minWords: "",
  maxWords: "",
  ctaStyle: "",
  forbiddenClaimsText: "",
  pricingPolicy: "",
  exampleMessagesText: "",
  objectionNotes: "",
};

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function CompanyProfileSettings() {
  const [profiles, setProfiles] = useState<CompanyProfilesListItem[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [completeness, setCompleteness] = useState<CompanyProfileCompleteness | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (key: keyof FormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const loadProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await listCompanyProfiles();
      setProfiles(res.profiles);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load company profiles.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    Promise.resolve().then(() => {
      if (!ignore) void loadProfiles();
    });
    return () => {
      ignore = true;
    };
  }, [loadProfiles]);

  const startEdit = (item: CompanyProfilesListItem) => {
    setSelectedProfileId(item.profile.id);
    setCompleteness(item.completeness);
    setForm({
      name: item.profile.name,
      isDefault: item.profile.isDefault,
      description: item.profile.description,
      servicesText: item.profile.services
        .map((s) => (s.value ? `${s.name} — ${s.value}` : s.name))
        .join("\n"),
      targetIndustriesText: item.profile.targetIndustries.join(", "),
      targetCountriesText: item.profile.targetCountries.join(", "),
      idealCustomerProfile: item.profile.idealCustomerProfile ?? "",
      brandTone: item.profile.brandTone ?? "",
      messageLanguage: item.profile.messageLanguage ?? "en",
      minWords: item.profile.preferredLength ? String(item.profile.preferredLength.minWords) : "",
      maxWords: item.profile.preferredLength ? String(item.profile.preferredLength.maxWords) : "",
      ctaStyle: item.profile.ctaStyle ?? "",
      forbiddenClaimsText: item.profile.forbiddenClaims.join(", "),
      pricingPolicy: item.profile.pricingPolicy ?? "",
      exampleMessagesText: item.profile.exampleMessages.join("\n"),
      objectionNotes: item.profile.objectionNotes ?? "",
    });
    setIsEditing(true);
    setIsCreating(false);
    setError(null);
    setSaved(false);
  };

  const startCreate = () => {
    setSelectedProfileId(null);
    setCompleteness(null);
    setForm({ ...EMPTY, isDefault: profiles.length === 0 });
    setIsCreating(true);
    setIsEditing(true);
    setError(null);
    setSaved(false);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setIsCreating(false);
    setSelectedProfileId(null);
    setError(null);
    setSaved(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      const min = Number(form.minWords);
      const max = Number(form.maxWords);
      const preferredLength =
        Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min
          ? { minWords: min, maxWords: max }
          : null;

      const services = splitLines(form.servicesText).map((entry) => {
        const [name, value] = entry.split(/\s+—\s+|\s+-\s+/);
        return value ? { name: name.trim(), value: value.trim() } : { name: entry.trim() };
      });

      const input: CompanyProfileInput = {
        name: form.name.trim(),
        isDefault: form.isDefault,
        description: form.description.trim(),
        services,
        targetIndustries: splitLines(form.targetIndustriesText),
        targetCountries: splitLines(form.targetCountriesText),
        idealCustomerProfile: form.idealCustomerProfile.trim() || null,
        brandTone: form.brandTone.trim() || null,
        messageLanguage: form.messageLanguage.trim() || "en",
        preferredLength,
        ctaStyle: form.ctaStyle.trim() || null,
        forbiddenClaims: splitLines(form.forbiddenClaimsText),
        pricingPolicy: form.pricingPolicy.trim() || null,
        exampleMessages: splitLines(form.exampleMessagesText),
        objectionNotes: form.objectionNotes.trim() || null,
      };

      if (isCreating || !selectedProfileId) {
        const res = await createCompanyProfile(input);
        setCompleteness(res.completeness);
      } else {
        const res = await updateCompanyProfile(selectedProfileId, input);
        setCompleteness(res.completeness);
      }

      setSaved(true);
      await loadProfiles();
      setIsEditing(false);
      setIsCreating(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save company profile.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (profileId: string) => {
    if (!confirm("Are you sure you want to delete this company profile?")) return;
    setError(null);
    try {
      await deleteCompanyProfile(profileId);
      await loadProfiles();
      if (selectedProfileId === profileId) {
        setIsEditing(false);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to delete company profile.");
    }
  };

  const handleSetDefault = async (profileId: string) => {
    setError(null);
    try {
      await updateCompanyProfile(profileId, { isDefault: true });
      await loadProfiles();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to set default profile.");
    }
  };

  const inputClass =
    "mt-1 w-full rounded-lg border border-subtle bg-surface px-3 py-2 text-xs text-primary placeholder-muted focus:border-indigo-500 focus:outline-none transition-colors";
  const labelClass = "block text-[11px] font-semibold uppercase text-muted";

  return (
    <section className="rounded-2xl border border-subtle bg-surface shadow-card p-6 space-y-6 transition-colors">
      <div className="flex flex-col gap-2 border-b border-subtle pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-primary">Company Profiles</h2>
          <p className="mt-0.5 text-xs text-muted">
            Create and manage distinct company contexts for different campaigns (services, tone,
            forbidden claims, CTA styles).
          </p>
        </div>
        {!isEditing && (
          <button
            type="button"
            onClick={startCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition cursor-pointer"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>New Profile</span>
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {saved && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5 text-xs text-emerald-700 dark:text-emerald-300">
          Company profile saved successfully.
        </div>
      )}

      {!isEditing ? (
        <div>
          {isLoading ? (
            <p className="text-xs text-muted py-4">Loading company profiles...</p>
          ) : profiles.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-subtle p-8 text-center bg-subtle/40">
              <p className="text-sm font-semibold text-primary">No company profiles yet</p>
              <p className="mt-1 text-xs text-muted">
                Create your first profile to configure AI analysis and messaging rules.
              </p>
              <button
                type="button"
                onClick={startCreate}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition cursor-pointer"
              >
                Create First Profile
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {profiles.map(({ profile, completeness: comp, campaignCount }) => (
                <div
                  key={profile.id}
                  className="rounded-xl border border-subtle bg-subtle p-4 flex flex-col justify-between hover:border-slate-300 dark:hover:border-slate-700 transition shadow-xs"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-primary">{profile.name}</h3>
                        {profile.isDefault && (
                          <span className="rounded-full bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold">
                            Default
                          </span>
                        )}
                      </div>
                      {comp.complete ? (
                        <span className="shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                          Ready for AI
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                          {comp.missingFields.length} missing
                        </span>
                      )}
                    </div>

                    <p className="mt-2 text-xs text-muted line-clamp-2">
                      {profile.description || "No description provided."}
                    </p>

                    <div className="mt-3 flex items-center gap-3 text-[11px] text-muted">
                      <span>{profile.services.length} service(s)</span>
                      <span>•</span>
                      <span>
                        {campaignCount === 1
                          ? "Used by 1 campaign"
                          : `Used by ${campaignCount} campaigns`}
                      </span>
                    </div>

                    {!comp.complete && (
                      <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                        Missing: {comp.missingFields.join(", ")}
                      </p>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-subtle flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {!profile.isDefault && (
                        <button
                          type="button"
                          onClick={() => handleSetDefault(profile.id)}
                          className="text-[11px] text-muted hover:text-primary transition cursor-pointer"
                        >
                          Make default
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit({ profile, completeness: comp, campaignCount })}
                        className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-2.5 py-1 text-xs font-medium text-secondary hover:text-primary transition shadow-card cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(profile.id)}
                        className="rounded-lg border border-rose-500/20 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-1 text-xs font-medium text-rose-700 dark:text-rose-400 transition cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-subtle pb-3">
            <h3 className="text-sm font-semibold text-primary">
              {isCreating ? "New Company Profile" : `Edit Profile: ${form.name}`}
            </h3>
            <button
              type="button"
              onClick={cancelEdit}
              className="text-xs text-muted hover:text-primary transition cursor-pointer"
            >
              Cancel
            </button>
          </div>

          {completeness && !completeness.complete && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3.5 text-xs text-amber-800 dark:text-amber-300">
              Missing required fields: {completeness.missingFields.join(", ")}. AI analysis and draft
              generation are blocked until these are filled.
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="cp-name">
                Profile Label / Company Name <span className="text-rose-500">*</span>
              </label>
              <input
                id="cp-name"
                className={inputClass}
                value={form.name}
                onChange={set("name")}
                placeholder="e.g. Healthcare Clinics Outreach"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-language">
                Message Language <span className="text-rose-500">*</span>
              </label>
              <input
                id="cp-language"
                className={inputClass}
                value={form.messageLanguage}
                onChange={set("messageLanguage")}
                placeholder="e.g. en"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(e) => setForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                  className="rounded border-subtle bg-surface text-indigo-600 focus:ring-indigo-500"
                />
                <span>Set as default profile (pre-filled starting point for new campaigns)</span>
              </label>
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-description">
                Company Description <span className="text-rose-500">*</span>
              </label>
              <textarea
                id="cp-description"
                rows={3}
                className={inputClass}
                value={form.description}
                onChange={set("description")}
                placeholder="What your company does, core value proposition, etc."
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-services">
                Services / Products <span className="text-rose-400">*</span> (one per line; optional &quot;Name — value&quot;)
              </label>
              <textarea
                id="cp-services"
                rows={3}
                className={inputClass}
                value={form.servicesText}
                onChange={set("servicesText")}
                placeholder={"Appointment Booking Software\nPatient Recall System — boosts repeat visits by 35%"}
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-industries">
                Target Industries <span className="text-rose-400">*</span> (comma separated)
              </label>
              <input
                id="cp-industries"
                className={inputClass}
                value={form.targetIndustriesText}
                onChange={set("targetIndustriesText")}
                placeholder="dental clinics, chiropractic, wellness"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-countries">
                Target Countries (comma separated, optional)
              </label>
              <input
                id="cp-countries"
                className={inputClass}
                value={form.targetCountriesText}
                onChange={set("targetCountriesText")}
                placeholder="US, CA, UK"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-tone">
                Brand Tone <span className="text-rose-400">*</span>
              </label>
              <input
                id="cp-tone"
                className={inputClass}
                value={form.brandTone}
                onChange={set("brandTone")}
                placeholder="professional, consultative, friendly"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-cta">
                CTA Style <span className="text-rose-400">*</span>
              </label>
              <input
                id="cp-cta"
                className={inputClass}
                value={form.ctaStyle}
                onChange={set("ctaStyle")}
                placeholder="soft question inviting feedback"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-min">
                Preferred Length — Min Words <span className="text-rose-400">*</span>
              </label>
              <input
                id="cp-min"
                type="number"
                className={inputClass}
                value={form.minWords}
                onChange={set("minWords")}
                placeholder="10"
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="cp-max">
                Preferred Length — Max Words <span className="text-rose-400">*</span>
              </label>
              <input
                id="cp-max"
                type="number"
                className={inputClass}
                value={form.maxWords}
                onChange={set("maxWords")}
                placeholder="60"
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-pricing">
                Pricing Policy <span className="text-rose-400">*</span>
              </label>
              <input
                id="cp-pricing"
                className={inputClass}
                value={form.pricingPolicy}
                onChange={set("pricingPolicy")}
                placeholder="do not disclose price in first DM; custom quotes after discovery"
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-ideal">
                Ideal Customer Profile (optional)
              </label>
              <textarea
                id="cp-ideal"
                rows={2}
                className={inputClass}
                value={form.idealCustomerProfile}
                onChange={set("idealCustomerProfile")}
                placeholder="Private healthcare clinics with 2-10 practitioners"
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-forbidden">
                Forbidden Claims / Words (comma separated)
              </label>
              <input
                id="cp-forbidden"
                className={inputClass}
                value={form.forbiddenClaimsText}
                onChange={set("forbiddenClaimsText")}
                placeholder="guaranteed, 100% free, secret algorithm"
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-examples">
                Example Good Messages (one per line, optional)
              </label>
              <textarea
                id="cp-examples"
                rows={3}
                className={inputClass}
                value={form.exampleMessagesText}
                onChange={set("exampleMessagesText")}
                placeholder="Hi {name}, noticed your clinic in Chicago. We help dental offices..."
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="cp-objections">
                Objection Handling Notes (optional)
              </label>
              <textarea
                id="cp-objections"
                rows={2}
                className={inputClass}
                value={form.objectionNotes}
                onChange={set("objectionNotes")}
                placeholder="If they say they already have software, emphasize our integration capabilities."
              />
            </div>

            <div className="sm:col-span-2 flex items-center justify-end gap-3 pt-4 border-t border-subtle">
              <button
                type="button"
                onClick={cancelEdit}
                disabled={isSaving}
                className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-4 py-2 text-xs font-semibold text-secondary hover:text-primary transition shadow-card cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                id="save-company-profile"
                onClick={handleSave}
                disabled={isSaving}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 px-5 py-2 text-xs font-semibold text-white shadow-sm shadow-indigo-500/20 transition disabled:opacity-40 cursor-pointer"
              >
                {isSaving ? "Saving..." : isCreating ? "Create Profile" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
