"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCampaignTemplates,
  createCampaignTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplateLeads,
  getCampaignTemplateSuggestions,
  type MessageTemplate,
  type TemplateLeadsPreviewResult,
  type TemplateSuggestionItem,
} from "@/lib/api/templates";
import { getCampaignLeads, type Lead } from "@/lib/api/leads";
import { ApiClientError } from "@/lib/api/client";
import {
  TEMPLATE_VARIABLE_DEFINITIONS,
  validateTemplateVariables,
} from "@/lib/services/template/template-renderer";
import {
  MAX_PREVIEW_LEADS,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from "@/lib/services/template/template-constants";
import { ConfirmModal } from "./confirm-modal";

type CampaignTemplatesTabProps = {
  campaignId: string;
  campaignName: string;
};

export function CampaignTemplatesTab({
  campaignId,
  campaignName,
}: CampaignTemplatesTabProps) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Editor state
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [formName, setFormName] = useState("");
  const [formBody, setFormBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Delete state
  const [deletingTemplate, setDeletingTemplate] = useState<MessageTemplate | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Preview state
  const [previewTemplate, setPreviewTemplate] = useState<MessageTemplate | null>(null);
  const [previewLeads, setPreviewLeads] = useState<Lead[]>([]);
  const [isLeadsLoading, setIsLeadsLoading] = useState(false);
  const [selectedPreviewLeadIds, setSelectedPreviewLeadIds] = useState<string[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<TemplateLeadsPreviewResult | null>(null);

  // AI Suggestion state
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<TemplateSuggestionItem[]>([]);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getCampaignTemplates(campaignId);
      setTemplates(data);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to load message templates.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    let isMounted = true;
    Promise.resolve().then(() => {
      if (isMounted) fetchTemplates();
    });
    return () => {
      isMounted = false;
    };
  }, [fetchTemplates]);

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const handleOpenCreate = () => {
    setEditingTemplate(null);
    setFormName("Quick Question (High Reply)");
    setFormBody(
      "Hey {{firstName}}, loved what you're doing in the {{businessCategory}} space! Quick question regarding {{campaignName}} — are you currently taking on new projects this month?",
    );
    setFormError(null);
    setIsEditorOpen(true);
  };

  const handleFetchSuggestions = async () => {
    setIsSuggesting(true);
    setFormError(null);
    try {
      const res = await getCampaignTemplateSuggestions(campaignId);
      if (res?.suggestions?.length > 0) {
        setSuggestions(res.suggestions);
        // Automatically adopt the top curiosity question suggestion if form is empty or default
        if (!formName || formName.includes("Quick Question") || formName.includes("New")) {
          const top = res.suggestions[0];
          setFormName(top.name);
          setFormBody(top.body);
        }
        showSuccess(`Loaded ${res.suggestions.length} AI suggestions based on campaign intent!`);
      }
    } catch {
      setFormError("Could not fetch AI suggestions for this campaign.");
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleApplyPreset = (name: string, body: string) => {
    setFormName(name);
    setFormBody(body);
    setFormError(null);
  };

  const handleOpenEdit = (tmpl: MessageTemplate) => {
    setEditingTemplate(tmpl);
    setFormName(tmpl.name);
    setFormBody(tmpl.body);
    setFormError(null);
    setIsEditorOpen(true);
  };

  const handleDuplicate = (tmpl: MessageTemplate) => {
    setEditingTemplate(null);
    setFormName(`${tmpl.name} (copy)`.slice(0, MAX_TEMPLATE_NAME_LENGTH));
    setFormBody(tmpl.body);
    setFormError(null);
    setIsEditorOpen(true);
  };

  /** Inserts a variable at the current cursor position (works mid-text too). */
  const handleInsertVariable = (variableTag: string) => {
    const textarea = bodyRef.current;
    if (!textarea) {
      setFormBody((prev) => prev + variableTag);
      return;
    }

    const start = textarea.selectionStart ?? formBody.length;
    const end = textarea.selectionEnd ?? formBody.length;
    const next = `${formBody.slice(0, start)}${variableTag}${formBody.slice(end)}`;

    if (next.length > MAX_TEMPLATE_BODY_LENGTH) {
      setFormError(
        `Message cannot exceed ${MAX_TEMPLATE_BODY_LENGTH} characters.`,
      );
      return;
    }

    setFormBody(next);
    const caret = start + variableTag.length;
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    const name = formName.trim();
    const body = formBody.trim();

    if (!name) {
      setFormError("Template name is required.");
      return;
    }
    if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
      setFormError(`Template name cannot exceed ${MAX_TEMPLATE_NAME_LENGTH} characters.`);
      return;
    }
    if (!body) {
      setFormError("Message is required.");
      return;
    }
    if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
      setFormError(`Message cannot exceed ${MAX_TEMPLATE_BODY_LENGTH} characters.`);
      return;
    }
    const { valid, unsupported } = validateTemplateVariables(body);
    if (!valid) {
      setFormError(
        `Unsupported variable(s): ${unsupported
          .map((v) => `{{${v}}}`)
          .join(", ")}. Use the variable buttons above.`,
      );
      return;
    }

    setIsSaving(true);
    setFormError(null);

    try {
      if (editingTemplate) {
        await updateTemplate(editingTemplate.id, { name, body });
        showSuccess("Template updated.");
      } else {
        await createCampaignTemplate(campaignId, { name, body });
        showSuccess("Template created.");
      }
      setIsEditorOpen(false);
      await fetchTemplates();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "Failed to save template.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingTemplate) return;
    setIsDeleting(true);
    try {
      await deleteTemplate(deletingTemplate.id);
      setDeletingTemplate(null);
      showSuccess("Template deleted.");
      await fetchTemplates();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Failed to delete template.",
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleOpenPreview = (tmpl: MessageTemplate) => {
    setPreviewTemplate(tmpl);
    setPreviewLeads([]);
    setSelectedPreviewLeadIds([]);
    setPreviewResult(null);
    setPreviewError(null);
    setIsLeadsLoading(true);

    getCampaignLeads(campaignId, { page: 1, limit: 25 })
      .then((data) => {
        const items = data.items ?? [];
        setPreviewLeads(items);
        setSelectedPreviewLeadIds(items.slice(0, 3).map((lead) => lead.id));
      })
      .catch((err) => {
        setPreviewError(
          err instanceof ApiClientError ? err.message : "Failed to load campaign leads.",
        );
      })
      .finally(() => setIsLeadsLoading(false));
  };

  const togglePreviewLead = (leadId: string) => {
    setPreviewResult(null);
    setSelectedPreviewLeadIds((prev) => {
      if (prev.includes(leadId)) {
        return prev.filter((id) => id !== leadId);
      }
      if (prev.length >= MAX_PREVIEW_LEADS) {
        return prev;
      }
      return [...prev, leadId];
    });
  };

  const handleRunPreview = async () => {
    if (!previewTemplate || selectedPreviewLeadIds.length === 0) return;
    setIsPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await previewTemplateLeads(
        previewTemplate.id,
        campaignId,
        selectedPreviewLeadIds,
      );
      setPreviewResult(result);
    } catch (err) {
      setPreviewError(
        err instanceof ApiClientError ? err.message : "Failed to render preview.",
      );
    } finally {
      setIsPreviewLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">Message Templates</h2>
          <p className="text-xs text-zinc-400">
            Create and manage outreach templates with dynamic lead variables for
            this campaign. Previews are draft-only.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreate}
          id="create-template-btn"
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-rose-950/40 transition hover:bg-rose-500 focus:outline-none"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>New Template</span>
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-300">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-300">
          {successMessage}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-44 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-5 animate-pulse">
              <div className="h-4 w-36 rounded bg-zinc-800 mb-3" />
              <div className="h-16 rounded bg-zinc-800/60 mb-4" />
              <div className="h-6 w-24 rounded bg-zinc-800" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/30 p-12 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-800 text-zinc-400">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-zinc-200">No message templates yet</h3>
          <p className="mt-1 text-xs text-zinc-500 max-w-sm mx-auto">
            Add reusable message templates with personalized lead variables like{" "}
            <code className="text-rose-400 font-mono">{"{{firstName}}"}</code> and{" "}
            <code className="text-rose-400 font-mono">{"{{businessCategory}}"}</code>.
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={handleOpenCreate}
              className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 transition"
            >
              <span>Create First Template</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {templates.map((tmpl) => (
            <div
              key={tmpl.id}
              data-template-id={tmpl.id}
              className="group flex flex-col justify-between rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 transition hover:border-zinc-700 hover:bg-zinc-900"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                      <span>{tmpl.name}</span>
                      {tmpl.campaignId === null && (
                        <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                          GLOBAL
                        </span>
                      )}
                    </h3>
                    <span className="text-[10px] text-zinc-500">
                      Created {new Date(tmpl.createdAt).toLocaleDateString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleOpenPreview(tmpl)}
                      title="Preview with real leads"
                      data-testid={`preview-template-${tmpl.id}`}
                      className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDuplicate(tmpl)}
                      title="Duplicate template"
                      data-testid={`duplicate-template-${tmpl.id}`}
                      className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-2M6 9h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z" />
                      </svg>
                    </button>
                    {tmpl.campaignId !== null && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleOpenEdit(tmpl)}
                          title="Edit template"
                          data-testid={`edit-template-${tmpl.id}`}
                          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingTemplate(tmpl)}
                          title="Delete template"
                          data-testid={`delete-template-${tmpl.id}`}
                          className="rounded-lg p-1.5 text-zinc-400 hover:bg-rose-950/40 hover:text-rose-400 transition"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
                  <p className="whitespace-pre-wrap text-xs font-mono text-zinc-300 line-clamp-3">
                    {tmpl.body}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-zinc-800/80 pt-3 text-[11px] text-zinc-500">
                <span>{tmpl.body.length} characters</span>
                <button
                  type="button"
                  onClick={() => handleOpenPreview(tmpl)}
                  className="font-medium text-rose-400 hover:underline"
                >
                  Preview with leads →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {isEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-xs"
            onClick={() => !isSaving && setIsEditorOpen(false)}
          />

          <div className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-zinc-100">
                {editingTemplate ? "Edit Message Template" : "New Message Template"}
              </h3>
              <button
                type="button"
                onClick={() => setIsEditorOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {formError && (
              <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleSave} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Template Name *
                </label>
                <input
                  type="text"
                  required
                  maxLength={MAX_TEMPLATE_NAME_LENGTH}
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Fitness Outreach"
                  className="mt-1 block w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Message *
                  </label>
                  <span
                    className={`text-[11px] ${
                      formBody.length > MAX_TEMPLATE_BODY_LENGTH
                        ? "text-rose-400"
                        : "text-zinc-500"
                    }`}
                  >
                    Characters: {formBody.length} / {MAX_TEMPLATE_BODY_LENGTH}
                  </span>
                </div>

                {/* AI Suggestion & Proven High-Reply Presets */}
                <div className="mt-2 rounded-xl border border-sky-500/30 bg-sky-950/20 p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
                      <span className="text-xs font-semibold text-sky-200">
                        AI Intent & High-Reply Angles
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleFetchSuggestions()}
                      disabled={isSuggesting}
                      className="rounded-lg border border-sky-500/40 bg-sky-600/20 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:bg-sky-600/30 transition disabled:opacity-50"
                    >
                      {isSuggesting ? "Generating..." : "✨ AI Suggest from Campaign Intent"}
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Select a proven response angle to load copy designed specifically to convince leads to reply:
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          "Quick Question (High Reply)",
                          "Hey {{firstName}}, loved what you're doing in the {{businessCategory}} space! Quick question regarding {{campaignName}} — are you currently taking on new projects this month?",
                        )
                      }
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 hover:border-sky-500 hover:text-sky-300 transition"
                    >
                      💡 Quick Question (Curiosity Hook)
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          "Value-First Resource",
                          "Hi {{firstName}}, noticed your focus in {{businessCategory}}. We recently put together a quick 30-sec breakdown on {{campaignName}} tailored for creators in your niche. Mind if I drop the key takeaways here?",
                        )
                      }
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 hover:border-emerald-500 hover:text-emerald-300 transition"
                    >
                      🎁 Value-First Resource
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          "Peer Collaboration",
                          "Hey {{firstName}}, your work in {{businessCategory}} caught our eye. We're actively connecting with select profiles in your space for {{campaignName}}. Would you be open to exploring a quick collaboration?",
                        )
                      }
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 hover:border-purple-500 hover:text-purple-300 transition"
                    >
                      🤝 Peer Collaboration
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleApplyPreset(
                          "Direct Problem-Solving",
                          "Hey {{firstName}}, working with others in {{businessCategory}} on {{campaignName}}, we noticed a lot of people struggle with inconsistent results. Open to seeing a quick 30-second example of how we solved it?",
                        )
                      }
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 hover:border-amber-500 hover:text-amber-300 transition"
                    >
                      🎯 Problem-Solving
                    </button>
                  </div>

                  {suggestions.length > 0 && (
                    <div className="mt-2 space-y-1.5 border-t border-sky-500/20 pt-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300 block">
                        Tailored suggestions for &ldquo;{campaignName}&rdquo;:
                      </span>
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {suggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleApplyPreset(item.name, item.body)}
                            className="rounded-lg border border-sky-500/20 bg-zinc-900/80 p-2 text-left hover:border-sky-400 transition"
                          >
                            <span className="block text-[11px] font-semibold text-sky-200">
                              {item.name}
                            </span>
                            <span className="mt-0.5 line-clamp-2 text-[10px] text-zinc-400">
                              {item.description}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-1.5">
                    Insert variable at cursor:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {TEMPLATE_VARIABLE_DEFINITIONS.map((variable) => (
                      <button
                        key={variable.name}
                        type="button"
                        onClick={() => handleInsertVariable(`{{${variable.name}}}`)}
                        title={variable.description}
                        className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2 py-1 text-[11px] font-mono text-rose-300 hover:border-rose-500 hover:bg-rose-500/10 transition"
                      >
                        + {variable.label}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  ref={bodyRef}
                  rows={6}
                  required
                  maxLength={MAX_TEMPLATE_BODY_LENGTH}
                  value={formBody}
                  onChange={(e) => setFormBody(e.target.value)}
                  placeholder="Write your template message with variables like {{firstName}}..."
                  className="mt-2 block w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none leading-relaxed"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setIsEditorOpen(false)}
                  className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving || !formName.trim() || !formBody.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-rose-500 disabled:opacity-50"
                >
                  {isSaving && (
                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  )}
                  <span>{editingTemplate ? "Save Changes" : "Create Template"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Preview with real leads */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-xs"
            onClick={() => setPreviewTemplate(null)}
          />

          <div className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-zinc-100">
                  Preview: {previewTemplate.name}
                </h3>
                <p className="text-[10px] text-zinc-500">Campaign: {campaignName}</p>
                <span className="mt-1 inline-block rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-300">
                  PREVIEW — NOT SENT
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTemplate(null)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                Raw Template
              </span>
              <div className="mt-1 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs font-mono text-zinc-400 whitespace-pre-wrap">
                {previewTemplate.body}
              </div>
            </div>

            {previewError && (
              <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {previewError}
              </div>
            )}

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Select Campaign Leads ({selectedPreviewLeadIds.length}/{MAX_PREVIEW_LEADS})
                </span>
                {isLeadsLoading && <span className="text-[11px] text-zinc-500">Loading leads…</span>}
              </div>

              {isLeadsLoading ? (
                <div className="mt-2 space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-800/60" />
                  ))}
                </div>
              ) : previewLeads.length === 0 ? (
                <div className="mt-2 rounded-xl border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
                  No leads available for preview. Scrape or discover leads first.
                </div>
              ) : (
                <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/60 p-2">
                  {previewLeads.map((lead) => {
                    const checked = selectedPreviewLeadIds.includes(lead.id);
                    const disabled = !checked && selectedPreviewLeadIds.length >= MAX_PREVIEW_LEADS;
                    return (
                      <label
                        key={lead.id}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs transition ${
                          checked ? "bg-rose-500/10 text-rose-200" : "text-zinc-300 hover:bg-zinc-800/60"
                        } ${disabled ? "opacity-40" : ""}`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => togglePreviewLead(lead.id)}
                            className="h-3.5 w-3.5 accent-rose-500"
                          />
                          <span className="font-medium">{lead.fullName || lead.username}</span>
                          <span className="text-zinc-500">@{lead.username}</span>
                        </span>
                        <span className="text-[10px] text-zinc-500">
                          {lead.followers !== null ? `${lead.followers} followers` : "—"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleRunPreview}
                  disabled={
                    isPreviewLoading ||
                    selectedPreviewLeadIds.length === 0 ||
                    previewLeads.length === 0
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-50"
                >
                  {isPreviewLoading && (
                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <span>Render Preview</span>
                </button>
              </div>
            </div>

            {previewResult && (
              <div className="mt-4 space-y-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  Rendered Preview ({previewResult.previews.length}) — NOT SENT
                </span>
                {previewResult.previews.map((preview) => (
                  <div
                    key={preview.lead.id}
                    className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5"
                  >
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span>
                        <strong className="text-zinc-200">
                          {preview.lead.fullName || preview.lead.username}
                        </strong>{" "}
                        @{preview.lead.username}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {preview.text.length} chars
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-100">
                      {preview.text}
                    </p>
                    {preview.missingVariables.length > 0 && (
                      <p className="mt-2 text-[10px] text-amber-400">
                        Missing lead data for:{" "}
                        {preview.missingVariables
                          .map((v) => `{{${v}}}`)
                          .join(", ")}{" "}
                        (rendered as empty).
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setPreviewTemplate(null)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={Boolean(deletingTemplate)}
        title="Delete Message Template"
        message={`Are you sure you want to delete template "${deletingTemplate?.name}"? This action cannot be undone.`}
        confirmLabel="Delete Template"
        isDangerous={true}
        isLoading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setDeletingTemplate(null)}
      />
    </div>
  );
}
