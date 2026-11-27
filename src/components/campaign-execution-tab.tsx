"use client";

import { useEffect, useState, useCallback } from "react";
import {
  createCampaignExecution,
  getCampaignExecution,
  approveExecutionItem,
  skipExecutionItem,
  cancelCampaignExecution,
  dispatchCampaignExecution,
  type ExecutionDetailResponse,
  type ExecutionDetailItem,
  type ExecutionMode,
} from "@/lib/api/executions";
import {
  getCampaignTemplates,
  updateTemplate,
  createCampaignTemplate,
  type MessageTemplate,
} from "@/lib/api/templates";
import type { Lead } from "@/lib/api/leads";
import { getMe } from "@/lib/api/auth";
import {
  TEMPLATE_VARIABLE_DEFINITIONS,
  buildTemplateLeadContext,
  renderTemplate,
} from "@/lib/services/template/template-renderer";
import { ApiClientError } from "@/lib/api/client";
import { ConfirmModal } from "./confirm-modal";
import { useSendingStatus } from "./sending-banner";

// Derived from the centralized template variable definitions (single source of truth).
const TEMPLATE_VARIABLES = TEMPLATE_VARIABLE_DEFINITIONS.map(
  (definition) => `{{${definition.name}}}`,
);

type CampaignExecutionTabProps = {
  campaignId: string;
  campaignName: string;
  campaignExecutionMode?: string;
  selectedLeads?: Lead[];
  onClearSelection?: () => void;
};

export function CampaignExecutionTab({
  campaignId,
  campaignName,
  campaignExecutionMode = "MANUAL",
  selectedLeads = [],
  onClearSelection,
}: CampaignExecutionTabProps) {
  const { sendingEnabled } = useSendingStatus();
  const previewLead = selectedLeads[0] ?? null;
  // Templates state
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(
    (campaignExecutionMode as ExecutionMode) || "MANUAL",
  );

  // Execution State
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [execution, setExecution] = useState<ExecutionDetailResponse | null>(null);
  const [isLoadingExecution, setIsLoadingExecution] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filtering & Pagination
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);

  // Modals & Editing
  const [editingItem, setEditingItem] = useState<ExecutionDetailItem | null>(null);
  const [editMessageText, setEditMessageText] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // Template editor + controlled dispatch state
  const [templateBody, setTemplateBody] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchSummary, setDispatchSummary] = useState<string | null>(null);
  const [senderName, setSenderName] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    getMe()
      .then(({ user }) => {
        if (isMounted) setSenderName(user?.name ?? null);
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, []);

  // Fetch templates for selector
  useEffect(() => {
    let isMounted = true;
    Promise.resolve().then(() => {
      if (!isMounted) return;
      getCampaignTemplates(campaignId)
        .then((data) => {
          if (isMounted) {
            setTemplates(data);
            if (data.length > 0) {
              setSelectedTemplateId(data[0].id);
              setTemplateBody(data[0].body);
            }
          }
        })
        .catch(() => undefined);
    });
    return () => {
      isMounted = false;
    };
  }, [campaignId]);

  // Load execution detail
  const loadExecution = useCallback(
    async (execId: string) => {
      setIsLoadingExecution(true);
      setError(null);
      try {
        const data = await getCampaignExecution(execId, {
          page,
          limit: 20,
          status: statusFilter || undefined,
        });
        setExecution(data);
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Failed to load execution details.",
        );
      } finally {
        setIsLoadingExecution(false);
      }
    },
    [page, statusFilter],
  );

  useEffect(() => {
    if (!activeExecutionId) return;
    let isMounted = true;
    Promise.resolve().then(() => {
      if (isMounted) {
        loadExecution(activeExecutionId);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [activeExecutionId, loadExecution]);

  const selectedTemplate =
    templates.find((t) => t.id === selectedTemplateId) ?? null;
  const previewText = previewLead
    ? renderTemplate(
        templateBody,
        buildTemplateLeadContext(previewLead),
        campaignName,
        senderName,
      )
    : "";

  // Save the inline message template (update existing, or create one).
  const handleSaveTemplate = async () => {
    if (!templateBody.trim()) {
      setError("Message template cannot be empty.");
      return;
    }
    setIsSavingTemplate(true);
    setError(null);
    try {
      if (selectedTemplate) {
        const updated = await updateTemplate(selectedTemplate.id, {
          body: templateBody,
        });
        setTemplates((prev) =>
          prev.map((t) => (t.id === updated.id ? updated : t)),
        );
        setSuccessMessage("Message template saved.");
      } else {
        const created = await createCampaignTemplate(campaignId, {
          name: "Campaign Message",
          body: templateBody,
        });
        setTemplates((prev) => [...prev, created]);
        setSelectedTemplateId(created.id);
        setSuccessMessage("Message template created.");
      }
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to save the message template.",
      );
    } finally {
      setIsSavingTemplate(false);
    }
  };

  // Dispatch ONLY approved items through the controlled messaging provider.
  const handleDispatch = async () => {
    if (!activeExecutionId) return;
    setIsDispatching(true);
    setShowSendConfirm(false);
    setError(null);
    setDispatchSummary(null);
    try {
      const result = await dispatchCampaignExecution(activeExecutionId);
      setDispatchSummary(
        `Attempted ${result.attempted}: sent ${result.sent}, failed ${result.failed}. ` +
          `Remaining approved: ${result.remainingApproved}.` +
          (result.errorMessage ? ` ${result.errorMessage}` : ""),
      );
      await loadExecution(activeExecutionId);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to send approved messages.",
      );
    } finally {
      setIsDispatching(false);
    }
  };

  // Handle generating preview
  const handleGeneratePreview = async () => {
    setIsGenerating(true);
    setError(null);
    setSuccessMessage(null);
    setDispatchSummary(null);
    try {
      const preview = await createCampaignExecution(campaignId, {
        templateId: selectedTemplateId || undefined,
        executionMode,
        leadIds:
          selectedLeads.length > 0
            ? selectedLeads.map((lead) => lead.id)
            : undefined,
      });

      setActiveExecutionId(preview.executionId);
      setSuccessMessage(
        `Generated execution preview with ${preview.planned} planned message draft(s) for ` +
          `${selectedLeads.length > 0 ? `${selectedLeads.length} selected lead(s)` : "all eligible leads"}. ` +
          `Review below before approving.`,
      );
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to generate execution preview.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle Item Approve
  const handleApprove = async (item: ExecutionDetailItem, customText?: string) => {
    if (!activeExecutionId) return;
    try {
      await approveExecutionItem(
        activeExecutionId,
        item.id,
        customText ?? item.messageText,
      );
      setEditingItem(null);
      await loadExecution(activeExecutionId);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to approve execution item.",
      );
    }
  };

  // Handle Item Skip
  const handleSkip = async (itemId: string) => {
    if (!activeExecutionId) return;
    try {
      await skipExecutionItem(activeExecutionId, itemId);
      await loadExecution(activeExecutionId);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to skip execution item.",
      );
    }
  };

  // Handle Cancel Execution
  const handleCancelExecution = async () => {
    if (!activeExecutionId) return;
    setIsCancelling(true);
    try {
      await cancelCampaignExecution(activeExecutionId);
      setShowCancelModal(false);
      await loadExecution(activeExecutionId);
      setSuccessMessage("Execution preview was cancelled.");
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Failed to cancel execution.",
      );
    } finally {
      setIsCancelling(false);
    }
  };

  const getItemBadge = (status: string) => {
    switch (status) {
      case "APPROVED":
        return (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
            APPROVED
          </span>
        );
      case "SENDING":
        return (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
            SENDING
          </span>
        );
      case "SKIPPED":
        return (
          <span className="rounded bg-zinc-500/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 border border-zinc-500/20">
            SKIPPED
          </span>
        );
      case "SENT":
        return (
          <span className="rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-400 border border-sky-500/20">
            SENT
          </span>
        );
      case "FAILED":
        return (
          <span className="rounded bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-400 border border-rose-500/20">
            FAILED
          </span>
        );
      case "PENDING":
      default:
        return (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
            PENDING REVIEW
          </span>
        );
    }
  };

  const approvedCount = execution?.approvedItems ?? 0;
  const skippedCount = execution?.skippedItems ?? 0;

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">
            Campaign Execution & Review
          </h2>
          <p className="text-xs text-zinc-400">
            Generate and review personalized execution drafts with strict human-in-the-loop controls.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {execution &&
            (execution.status === "PREVIEW" ||
              execution.status === "READY") && (
              <button
                type="button"
                onClick={() => setShowCancelModal(true)}
                className="rounded-xl border border-rose-900/50 bg-rose-950/30 px-3.5 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-900/40 transition"
              >
                Cancel Preview
              </button>
            )}
        </div>
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

      {/* Message Template + Personalized Preview */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
          <h3 className="text-sm font-bold text-zinc-200">Message Template</h3>
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>
              Selected:{" "}
              <strong className="text-zinc-200">{selectedLeads.length}</strong>
            </span>
            {selectedLeads.length > 0 && onClearSelection && (
              <button
                type="button"
                onClick={onClearSelection}
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 font-medium text-zinc-200 transition hover:bg-zinc-700"
              >
                Clear Selection
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <textarea
              rows={8}
              value={templateBody}
              onChange={(e) => setTemplateBody(e.target.value)}
              placeholder={
                "Hi {{firstName}},\n\nI came across your Instagram profile and wanted to reach out regarding {{campaignName}}.\n\nWould you be open to learning more?\n\nBest,\n{{senderName}}"
              }
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-sans text-xs leading-relaxed text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
            />
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() =>
                    setTemplateBody((prev) => `${prev}${variable}`)
                  }
                  className="rounded-md border border-zinc-700/70 bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 transition hover:bg-zinc-700"
                >
                  {variable}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] text-zinc-500">
                Missing variables render empty. You can edit each message before
                sending.
              </span>
              <button
                type="button"
                onClick={handleSaveTemplate}
                disabled={isSavingTemplate || !templateBody.trim()}
                className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-40"
              >
                {isSavingTemplate ? "Saving..." : "Save Template"}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Message Preview
              </span>
              {previewLead && (
                <span className="text-[10px] text-zinc-500">
                  @{previewLead.username}
                </span>
              )}
            </div>
            <div className="min-h-[8rem] whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-xs leading-relaxed text-zinc-200">
              {previewLead ? (
                previewText || (
                  <span className="italic text-zinc-500">
                    Template is empty.
                  </span>
                )
              ) : (
                <span className="italic text-zinc-500">
                  Select leads in the Leads tab to preview a personalized
                  message.
                </span>
              )}
            </div>
            {previewLead && (
              <p className="text-[10px] text-zinc-500">
                Preview only — nothing is sent. Preview uses the first selected
                lead; per-lead drafts are generated in the execution preview.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Execution Setup & Generation Card */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
            <h3 className="text-sm font-bold text-zinc-200">
              Execution Preview Configuration
            </h3>
          </div>
          <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
            REVIEW REQUIRED
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Template Selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1">
              Select Message Template
            </label>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                const next = templates.find((t) => t.id === e.target.value);
                setTemplateBody(next?.body ?? "");
              }}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
            >
              {templates.length === 0 ? (
                <option value="">No templates found</option>
              ) : (
                templates.map((tmpl) => (
                  <option key={tmpl.id} value={tmpl.id}>
                    {tmpl.name} {tmpl.campaignId === null ? "(Global)" : ""}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Mode Selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1">
              Execution Mode
            </label>
            <select
              value={executionMode}
              onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
            >
              <option value="MANUAL">MANUAL (Manual single review)</option>
              <option value="REVIEW_REQUIRED">REVIEW_REQUIRED (Explicit approvals)</option>
            </select>
          </div>

          {/* Action Button */}
          <div className="flex flex-col justify-end">
            <button
              type="button"
              id="generate-execution-btn"
              disabled={isGenerating || templates.length === 0}
              onClick={handleGeneratePreview}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-rose-600 to-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-md transition hover:from-rose-500 hover:to-indigo-500 disabled:opacity-50"
            >
              {isGenerating ? (
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
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>Analyzing Leads & Generating Plan...</span>
                </>
              ) : (
                <>
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                    />
                  </svg>
                  <span>Generate Execution Preview</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Safety banner */}
        <div className="flex items-center gap-2 text-[11px] text-zinc-400 bg-zinc-950/60 rounded-xl p-3 border border-zinc-800/80">
          <svg
            className="h-4 w-4 text-amber-400 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>
            <strong>Human-in-the-Loop Guarantee:</strong> Generating an execution preview only prepares message drafts. Messages are <strong>never</strong> sent unattended or automatically.
          </span>
        </div>
      </div>

      {/* Execution Summary Stats Strip */}
      {execution && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Execution Status
            </span>
            <div className="mt-1 text-sm font-bold text-zinc-100 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span>{execution.status}</span>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Total Planned
            </span>
            <div className="mt-1 text-lg font-extrabold text-white">
              {execution.totalItems}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
              Approved
            </span>
            <div className="mt-1 text-lg font-extrabold text-emerald-400">
              {approvedCount}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              Skipped
            </span>
            <div className="mt-1 text-lg font-extrabold text-zinc-400">
              {skippedCount}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              Pending Review
            </span>
            <div className="mt-1 text-lg font-extrabold text-amber-400">
              {execution.totalItems - approvedCount - skippedCount}
            </div>
          </div>
        </div>
      )}

      {/* Review Table / Cards */}
      {execution && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-bold text-zinc-100">
                Planned Lead Items ({execution.pagination.total})
              </h3>
              {/* Filter */}
              <div className="flex items-center gap-1">
                {["", "PENDING", "APPROVED", "SKIPPED"].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => {
                      setStatusFilter(st);
                      setPage(1);
                    }}
                    className={`rounded-lg px-2.5 py-1 text-[10px] font-medium transition ${
                      statusFilter === st
                        ? "bg-zinc-800 text-zinc-100 font-bold"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {st === "" ? "All" : st}
                  </button>
                ))}
              </div>
            </div>

            <span className="text-[11px] text-zinc-500">
              Execution ID: {execution.id.slice(0, 10)}...
            </span>
          </div>

          {isLoadingExecution ? (
            <div className="p-8 text-center text-xs text-zinc-500 animate-pulse">
              Loading execution items...
            </div>
          ) : execution.items.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500 italic">
              No execution items found for this filter.
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/80">
              {execution.items.map((item) => (
                <div
                  key={item.id}
                  className="p-4 hover:bg-zinc-800/30 transition flex flex-col md:flex-row md:items-start justify-between gap-4"
                >
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <a
                        href={item.lead.profileUrl || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-bold text-rose-400 hover:underline flex items-center gap-1"
                      >
                        <span>{item.lead.username ? `@${item.lead.username}` : "lead"}</span>
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                      </a>

                      {item.lead.fullName && (
                        <span className="text-xs text-zinc-400 font-medium">
                          • {item.lead.fullName}
                        </span>
                      )}

                      {item.lead.category && (
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          {item.lead.category}
                        </span>
                      )}

                      {getItemBadge(item.status)}
                    </div>

                    <div className="rounded-xl border border-zinc-800/90 bg-zinc-950/70 p-3">
                      <p className="whitespace-pre-wrap text-xs font-sans text-zinc-200 leading-relaxed">
                        {item.messageText}
                      </p>
                    </div>
                  </div>

                  {/* Actions Column */}
                  <div className="flex items-center md:flex-col gap-2 shrink-0 md:pt-1">
                    {item.status === "PENDING" && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleApprove(item)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500 transition"
                        >
                          <svg
                            className="h-3.5 w-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          <span>Approve</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setEditingItem(item);
                            setEditMessageText(item.messageText);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-700 transition"
                        >
                          <span>Edit & Approve</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSkip(item.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
                        >
                          <span>Skip</span>
                        </button>
                      </>
                    )}

                    {item.status === "APPROVED" && (
                      <span className="text-[11px] text-emerald-400 font-medium">
                        ✓ Approved for dispatch
                      </span>
                    )}

                    {item.status === "SKIPPED" && (
                      <span className="text-[11px] text-zinc-500">
                        Skipped
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination bar */}
          {execution.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-zinc-800 px-5 py-3 text-xs text-zinc-400">
              <span>
                Page {execution.pagination.page} of {execution.pagination.totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= execution.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Controlled Dispatch */}
      {execution && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-3">
            <div>
              <h3 className="text-sm font-bold text-zinc-200">Execution</h3>
              <p className="mt-0.5 text-[11px] text-zinc-400">
                Only <strong className="text-zinc-300">APPROVED</strong>{" "}
                messages are dispatched, one at a time. Sending depends on the
                authenticated Instagram session and Instagram&apos;s current
                messaging permissions; restrictions are never bypassed.
              </p>
            </div>
            <span className="text-xs text-zinc-300">
              Selected (approved):{" "}
              <strong className="text-emerald-400">{approvedCount}</strong>
            </span>
          </div>

          {dispatchSummary && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
              {dispatchSummary}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              id="dispatch-approved-btn"
              disabled={!sendingEnabled || isDispatching || approvedCount === 0}
              title={!sendingEnabled ? "Sending is OFF - discovery only (OUTBOUND_SENDING_ENABLED=false)" : undefined}
              onClick={() => setShowSendConfirm(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white shadow-md transition hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isDispatching
                ? "Sending via browser..."
                : `Send Approved Messages (${approvedCount})`}
            </button>
          </div>
        </div>
      )}

      {/* Send Approved Messages Confirmation */}
      <ConfirmModal
        isOpen={showSendConfirm}
        title="Confirm Sending"
        message={`You are about to send messages to ${approvedCount} selected leads. Only approved messages will be dispatched through the authenticated browser session.`}
        confirmLabel="Proceed & Send"
        cancelLabel="Cancel"
        isDangerous={false}
        isLoading={isDispatching}
        onConfirm={handleDispatch}
        onCancel={() => setShowSendConfirm(false)}
      />

      {/* Edit & Approve Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/75 backdrop-blur-xs"
            onClick={() => !isSavingEdit && setEditingItem(null)}
          />

          <div className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-bold text-zinc-100">
                Edit Draft for @{editingItem.lead.username}
              </h3>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
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

            <div className="mt-4 space-y-3">
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Personalized Message
              </label>
              <textarea
                rows={5}
                value={editMessageText}
                onChange={(e) => setEditMessageText(e.target.value)}
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none font-sans leading-relaxed"
              />
            </div>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={isSavingEdit}
                onClick={() => setEditingItem(null)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingEdit || !editMessageText.trim()}
                onClick={async () => {
                  setIsSavingEdit(true);
                  await handleApprove(editingItem, editMessageText.trim());
                  setIsSavingEdit(false);
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <span>Save & Approve</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Execution Modal */}
      <ConfirmModal
        isOpen={showCancelModal}
        title="Cancel Execution Preview"
        message={`Are you sure you want to cancel this execution preview for "${campaignName}"? Planned items will be cancelled.`}
        confirmLabel="Cancel Execution"
        isDangerous={true}
        isLoading={isCancelling}
        onConfirm={handleCancelExecution}
        onCancel={() => setShowCancelModal(false)}
      />
    </div>
  );
}
