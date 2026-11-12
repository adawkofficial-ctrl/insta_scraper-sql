"use client";

import { useEffect, useState, useCallback } from "react";
import {
  previewBulkMessages,
  createBulkMessageJob,
  startBulkJob,
  type BulkPreviewResponse,
} from "@/lib/api/messaging";
import {
  getCampaignTemplates,
  type MessageTemplate,
} from "@/lib/api/templates";
import {
  listSenderAccounts,
  type InstagramSenderAccount,
} from "@/lib/api/senders";
import { useSendingStatus } from "@/components/sending-banner";

type BulkMessageModalProps = {
  isOpen: boolean;
  onClose: () => void;
  campaignId: string;
  selectedLeadIds: string[];
  selectionMode: "selected" | "allEligible";
  totalCampaignLeads: number;
  filters?: Record<string, unknown>;
  onJobStarted: (jobId: string) => void;
};

export function BulkMessageModal({
  isOpen,
  onClose,
  campaignId,
  selectedLeadIds,
  selectionMode,
  totalCampaignLeads,
  filters,
  onJobStarted,
}: BulkMessageModalProps) {
  const { sendingEnabled } = useSendingStatus();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateReloadToken, setTemplateReloadToken] = useState(0);

  const [senders, setSenders] = useState<InstagramSenderAccount[]>([]);
  const [selectedSenderAccountId, setSelectedSenderAccountId] = useState<string>("");
  const [isLoadingSenders, setIsLoadingSenders] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);

  const [previewData, setPreviewData] = useState<BulkPreviewResponse | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [showSkippedDetails, setShowSkippedDetails] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    setPreviewData(null);
    setSelectedTemplateId("");
    setConfirmed(false);
    setShowSkippedDetails(false);
    setPreviewError(null);
    setSubmitError(null);
    onClose();
  }, [onClose]);

  // Fetch templates for the CURRENT campaign when the modal opens (or the
  // campaign changes / a reload is requested). State is reset first so a
  // previous campaign's templates or a stale error can never leak in.
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;

    const loadTemplates = async () => {
      // Reset first so a previous campaign's templates or a stale error can
      // never leak into this render.
      setIsLoadingTemplates(true);
      setTemplateError(null);
      setTemplates([]);
      setSelectedTemplateId("");
      setPreviewData(null);

      try {
        const list = await getCampaignTemplates(campaignId);
        if (!isMounted) return;
        setTemplates(list);
        if (list.length > 0) {
          setSelectedTemplateId(list[0].id);
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        setTemplateError(
          err instanceof Error ? err.message : "Could not load templates",
        );
      } finally {
        if (isMounted) {
          setIsLoadingTemplates(false);
        }
      }
    };

    void loadTemplates();
    return () => {
      isMounted = false;
    };
  }, [isOpen, campaignId, templateReloadToken]);

  // Load the current user's Instagram sender accounts (only CONNECTED accounts
  // can actually dispatch).
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;

    const loadSenders = async () => {
      setIsLoadingSenders(true);
      setSenderError(null);
      setSenders([]);
      setSelectedSenderAccountId("");

      try {
        const list = await listSenderAccounts();
        if (!isMounted) return;
        setSenders(list);
        const connected = list.filter((sender) => sender.isConnected);
        if (connected.length > 1) {
          setSelectedSenderAccountId("round_robin");
        } else if (connected.length === 1) {
          setSelectedSenderAccountId(connected[0].id);
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        setSenderError(
          err instanceof Error ? err.message : "Could not load sender accounts",
        );
      } finally {
        if (isMounted) {
          setIsLoadingSenders(false);
        }
      }
    };

    void loadSenders();
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Fetch preview when template, sender, or selection changes
  useEffect(() => {
    if (!isOpen || !selectedTemplateId || !selectedSenderAccountId) return;

    let isMounted = true;
    const loadPreview = async () => {
      setIsPreviewLoading(true);
      setPreviewError(null);
      setPreviewData(null);
      try {
        const res = await previewBulkMessages(campaignId, {
          templateId: selectedTemplateId,
          senderAccountId:
            selectedSenderAccountId === "round_robin" ? undefined : selectedSenderAccountId,
          leadIds: selectionMode === "selected" ? selectedLeadIds : undefined,
          selection: selectionMode,
          filters,
        });
        if (isMounted) {
          setPreviewData(res);
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : "Failed to calculate recipient eligibility";
          setPreviewError(msg);
        }
      } finally {
        if (isMounted) {
          setIsPreviewLoading(false);
        }
      }
    };

    loadPreview();
    return () => {
      isMounted = false;
    };
  }, [isOpen, campaignId, selectedTemplateId, selectedSenderAccountId, selectionMode, selectedLeadIds, filters]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !isSubmitting) {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isSubmitting, handleClose]);

  if (!isOpen) return null;

  const handleStartSending = async () => {
    if (!confirmed || !selectedTemplateId || !selectedSenderAccountId || isSubmitting) return;
    if (!previewData || previewData.eligibleCount === 0) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Step 1: Create Job
      const createRes = await createBulkMessageJob(campaignId, {
        templateId: selectedTemplateId,
        senderAccountId:
          selectedSenderAccountId === "round_robin" ? undefined : selectedSenderAccountId,
        leadIds: selectionMode === "selected" ? selectedLeadIds : undefined,
        selection: selectionMode,
        filters,
      });

      const jobId = createRes.job.id;

      // Step 2: Trigger start queue
      await startBulkJob(jobId);

      // Step 3: Callback to parent
      onJobStarted(jobId);
      handleClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start bulk message job";
      setSubmitError(msg);
      setIsSubmitting(false);
    }
  };

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const connectedSenders = senders.filter((sender) => sender.isConnected);
  const hasConnectedSender = connectedSenders.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-xs transition-opacity"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/80">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div>
            <h3 className="text-lg font-bold text-zinc-100">
              Bulk Instagram Outreach
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Sequential, rate-controlled message delivery to eligible campaign leads
            </p>
          </div>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none disabled:opacity-50"
          >
            &times;
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* Target Leads Summary */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs flex items-center justify-between">
            <span className="text-zinc-400">Target Selection:</span>
            <span className="font-semibold text-rose-400">
              {selectionMode === "allEligible"
                ? `All eligible leads in campaign (${totalCampaignLeads} total records)`
                : `${selectedLeadIds.length} leads selected manually`}
            </span>
          </div>

          {/* Sender Account Selection */}
          <div>
            <label
              htmlFor="sender-select"
              className="block text-xs font-semibold uppercase text-zinc-400 mb-1.5"
            >
              Sender Account
            </label>
            {isLoadingSenders ? (
              <div className="text-xs text-zinc-500 py-2">Loading sender accounts...</div>
            ) : senderError ? (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                <div className="font-semibold">Could not load sender accounts</div>
                <div className="mt-0.5 text-rose-200/90">{senderError}</div>
              </div>
            ) : !hasConnectedSender ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                Connect and verify an Instagram sender account first.
              </div>
            ) : (
              <div>
                <select
                  id="sender-select"
                  value={selectedSenderAccountId}
                  onChange={(e) => setSelectedSenderAccountId(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
                >
                  {connectedSenders.length > 1 && (
                    <option value="round_robin">
                      All Connected Accounts ({connectedSenders.length}) · Sequential Round-Robin (10m Cooldown)
                    </option>
                  )}
                  {connectedSenders.map((sender) => (
                    <option key={sender.id} value={sender.id}>
                      @{sender.username}
                      {sender.displayName ? ` · ${sender.displayName}` : ""}
                    </option>
                  ))}
                </select>
                {selectedSenderAccountId === "round_robin" && (
                  <p className="mt-1.5 text-[11px] text-zinc-400">
                    Sequentially rotates across all {connectedSenders.length} accounts with a 10-minute cooldown per account (Account 1 &rarr; Lead 1, Account 2 &rarr; Lead 2...).
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Template Selection */}
          <div>
            <label
              htmlFor="template-select"
              className="block text-xs font-semibold uppercase text-zinc-400 mb-1.5"
            >
              Message Template
            </label>
            {isLoadingTemplates ? (
              <div className="text-xs text-zinc-500 py-2">Loading templates...</div>
            ) : templateError ? (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                <div className="font-semibold">Could not load templates</div>
                <div className="mt-0.5 text-rose-200/90">{templateError}</div>
                <button
                  type="button"
                  onClick={() => setTemplateReloadToken((n) => n + 1)}
                  className="mt-2 rounded-md border border-rose-500/40 px-2 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/20"
                >
                  Retry
                </button>
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                No templates found for this campaign. Please create a message template first.
              </div>
            ) : (
              <select
                id="template-select"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none"
              >
                {templates.map((tmpl) => (
                  <option key={tmpl.id} value={tmpl.id}>
                    {tmpl.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Template Preview Snippet */}
          {selectedTemplate && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              <span className="text-[10px] font-bold uppercase text-zinc-500 block mb-1">
                Raw Template Body
              </span>
              <p className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">
                {selectedTemplate.body}
              </p>
            </div>
          )}

          {/* Recipient Eligibility Breakdown */}
          {isPreviewLoading ? (
            <div className="py-4 text-center text-xs text-zinc-400 animate-pulse">
              Validating recipient eligibility and rendering variables...
            </div>
          ) : previewError ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              {previewError}
            </div>
          ) : previewData ? (
            <div className="space-y-3">
              {/* Metric Cards */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-2.5">
                  <div className="text-[11px] text-zinc-400">Evaluated</div>
                  <div className="text-base font-bold text-zinc-100">{previewData.totalSelected}</div>
                </div>
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-2.5">
                  <div className="text-[11px] text-emerald-400">Will Receive</div>
                  <div className="text-base font-bold text-emerald-300">{previewData.eligibleCount}</div>
                </div>
                <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-2.5">
                  <div className="text-[11px] text-amber-400">Skipped</div>
                  <div className="text-base font-bold text-amber-300">{previewData.skippedCount}</div>
                </div>
              </div>

              {/* Inspect Skipped Recipients */}
              {previewData.skippedCount > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-amber-300 font-medium">
                      {previewData.skippedCount} recipient{previewData.skippedCount > 1 ? "s" : ""} will be skipped
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowSkippedDetails(!showSkippedDetails)}
                      className="text-amber-400 hover:text-amber-200 underline text-[11px]"
                    >
                      {showSkippedDetails ? "Hide details" : "Inspect reasons"}
                    </button>
                  </div>

                  {showSkippedDetails && (
                    <div className="mt-2.5 max-h-36 overflow-y-auto space-y-1.5 border-t border-amber-500/20 pt-2 text-[11px]">
                      {previewData.skippedReasons.map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between text-zinc-400">
                          <span className="font-mono text-zinc-300">@{item.username}</span>
                          <span className="text-amber-400/90">{item.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Sample Rendered Messages */}
              {previewData.samples.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold uppercase text-zinc-400 block mb-1.5">
                    Personalized Message Samples
                  </span>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {previewData.samples.map((sample, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border border-zinc-800/80 bg-zinc-950 p-2.5 text-xs"
                      >
                        <div className="text-[11px] font-semibold text-rose-400 mb-1">
                          Recipient: @{sample.username}
                        </div>
                        <div className="text-zinc-300 font-mono whitespace-pre-wrap text-[11px]">
                          {sample.renderedMessage}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {/* Submission Error */}
          {submitError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-300">
              {submitError}
            </div>
          )}

          {/* Explicit Confirmation Checkbox */}
          {previewData && previewData.eligibleCount > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  id="confirm-bulk-send"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={isSubmitting}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-rose-500"
                />
                <span className="text-zinc-300">
                  I reviewed the recipients and personalized messages. I understand messages will be dispatched sequentially through the authenticated Instagram session.
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-zinc-800 pt-4">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 transition hover:bg-zinc-700 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            id="btn-start-bulk-sending"
            disabled={
              !sendingEnabled ||
              !confirmed ||
              !selectedTemplateId ||
              !selectedSenderAccountId ||
              isSubmitting ||
              !previewData ||
              previewData.eligibleCount === 0
            }
            title={!sendingEnabled ? "Sending is OFF - discovery only (OUTBOUND_SENDING_ENABLED=false)" : undefined}
            onClick={handleStartSending}
            className="rounded-lg bg-rose-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-rose-900/30 transition hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting
              ? "Creating & Queueing Job..."
              : `Start Sending (${previewData ? previewData.eligibleCount : 0})`}
          </button>
        </div>
      </div>
    </div>
  );
}
