"use client";

import { useEffect, useState } from "react";
import {
  getLead,
  updateLead,
  deleteLead,
  clearLeadDuplicateFlag,
  enrichLeads,
  enrichLeadHandle,
  findLeadContacts,
  recordLeadOutcomeEvent,
  type Lead,
  type LeadContactsInfo,
} from "@/lib/api/leads";
import {
  getMessagingStatus,
  sendSingleMessage,
  getLeadMessages,
  classifyMessage,
  type MessagingStatusResponse,
  type MessageHistoryItem,
} from "@/lib/api/messaging";
import { useSendingStatus } from "@/components/sending-banner";
import { approveDraft, rejectDraft, sendReplyDraft } from "@/lib/api/drafts";

import { ApiClientError } from "@/lib/api/client";
import {
  getCampaignTemplates,
  previewTemplateMessage,
  previewAIMessage,
  type MessageTemplate,
} from "@/lib/api/templates";
import {
  listSenderAccounts,
  type InstagramSenderAccount,
} from "@/lib/api/senders";
import { ConfirmModal } from "./confirm-modal";
import { LeadAvatar } from "./lead-avatar";
import { LeadDraftsPanel } from "./lead-drafts-panel";
import { SocialPlatformIcon, getLeadLinkClassification } from "./social-platform-icon";

type LeadDetailDrawerProps = {
  leadId: string | null;
  initialTab?: "profile" | "message";
  onClose: () => void;
  onLeadUpdated: () => void;
  onLeadDeleted: () => void;
};

export function LeadDetailDrawer({
  leadId,
  initialTab = "profile",
  onClose,
  onLeadUpdated,
  onLeadDeleted,
}: LeadDetailDrawerProps) {
  const { sendingEnabled } = useSendingStatus();
  const [activeTab, setActiveTab] = useState<"profile" | "message">(initialTab);
  const [lead, setLead] = useState<Lead | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAdditionalData, setShowAdditionalData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Edit form fields
  const [editFullName, setEditFullName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editBiography, setEditBiography] = useState("");
  const [editExternalUrl, setEditExternalUrl] = useState("");

  // Messaging State (Controlled Single-Recipient Test)
  const [providerStatus, setProviderStatus] = useState<MessagingStatusResponse | null>(null);
  const [testMessageText, setTestMessageText] = useState("");
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [showSendMessageConfirm, setShowSendMessageConfirm] = useState(false);
  const [messageResult, setMessageResult] = useState<{
    success: boolean;
    status: string;
    error?: { code: string; message: string };
  } | null>(null);
  const [messageHistory, setMessageHistory] = useState<MessageHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Template & AI Personalization State
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isAIPersonalizing, setIsAIPersonalizing] = useState(false);

  // Instagram sender account selection
  const [senders, setSenders] = useState<InstagramSenderAccount[]>([]);
  const [selectedSenderAccountId, setSelectedSenderAccountId] = useState<string>("");

  // Step 4 dedup: clearing a possible-duplicate flag.
  const [clearingDuplicate, setClearingDuplicate] = useState(false);
  const [classifyingId, setClassifyingId] = useState<string | null>(null);
  const [draftActionLoading, setDraftActionLoading] = useState<string | null>(null);
  const [composerFeedback, setComposerFeedback] = useState<{
    type: "info" | "ai" | "error";
    message: string;
  } | null>(null);

  // Profile on-demand enrichment state
  const [isEnriching, setIsEnriching] = useState(false);
  const [enrichFeedback, setEnrichFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Contact on-demand extraction state
  const [isFindingContacts, setIsFindingContacts] = useState(false);
  const [isFindingHandle, setIsFindingHandle] = useState(false);
  const [contactsFeedback, setContactsFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Manual outcome recording state
  const [recordingOutcome, setRecordingOutcome] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) return;

    let isMounted = true;
    Promise.resolve().then(() => {
      if (isMounted) {
        setIsLoading(true);
        setError(null);
        setIsEditing(false);
        setSaveSuccess(false);
        setMessageResult(null);
        setIsLoadingHistory(true);
        if (initialTab) {
          setActiveTab(initialTab);
        }
      }
    });

    // Fetch lead details
    getLead(leadId)
      .then((data) => {
        if (isMounted) {
          setLead(data);
          setEditFullName(data.fullName || "");
          setEditCategory(data.category || "");
          setEditBiography(data.biography || "");
          setEditExternalUrl(data.externalUrl || "");

          // Load campaign templates for this lead's campaign
          if (data.campaignId) {
            setIsLoadingTemplates(true);
            getCampaignTemplates(data.campaignId)
              .then((tmpls) => {
                if (isMounted) {
                  setTemplates(tmpls);
                  if (tmpls.length > 0) {
                    setSelectedTemplateId(tmpls[0].id);
                  }
                }
              })
              .catch(() => undefined)
              .finally(() => {
                if (isMounted) setIsLoadingTemplates(false);
              });
          }
        }
      })
      .catch((err) => {
        if (isMounted) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load lead details.");
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    // Fetch messaging provider status
    getMessagingStatus()
      .then((status) => {
        if (isMounted) setProviderStatus(status);
      })
      .catch(() => undefined);

    // Fetch message history for this lead
    getLeadMessages(leadId)
      .then((history) => {
        if (isMounted) setMessageHistory(history);
      })
      .catch(() => undefined)
      .finally(() => {
        if (isMounted) setIsLoadingHistory(false);
      });

    return () => {
      isMounted = false;
    };
  }, [leadId, initialTab]);

  // Load the current user's connected Instagram sender accounts. Only CONNECTED
  // accounts can dispatch; the selection is server-validated on send.
  useEffect(() => {
    if (!leadId) return;
    let isMounted = true;
    listSenderAccounts()
      .then((list) => {
        if (!isMounted) return;
        setSenders(list);
        setSelectedSenderAccountId((prev) => {
          if (prev && list.some((s) => s.id === prev && s.isConnected)) {
            return prev;
          }
          const firstConnected = list.find((s) => s.isConnected);
          return firstConnected ? firstConnected.id : "";
        });
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, [leadId]);

  if (!leadId) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lead) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      const updated = await updateLead(lead.id, {
        fullName: editFullName.trim() || null,
        category: editCategory.trim() || null,
        biography: editBiography.trim() || null,
        externalUrl: editExternalUrl.trim() || null,
      });

      setLead(updated);
      setIsEditing(false);
      setSaveSuccess(true);
      onLeadUpdated();
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save lead updates.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleEmailLeadAction = async (action: "email-reply" | "email-dnc") => {
    if (!lead) return;
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error("Request failed");
      setSuccessMessage(
        action === "email-reply"
          ? "Marked as replied and email/DNC updated. Honor STOP within 24 hours."
          : "Lead added to the email Do Not Contact list.",
      );
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update email status.");
    }
  };

  const handleDelete = async () => {    if (!lead) return;
    setIsDeleting(true);
    try {
      await deleteLead(lead.id);
      setShowDeleteConfirm(false);
      onClose();
      onLeadDeleted();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to delete lead.");
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePreviewTemplate = async () => {
    if (!lead || !selectedTemplateId) return;
    setIsPreviewing(true);
    setComposerFeedback(null);
    try {
      const res = await previewTemplateMessage(lead.id, selectedTemplateId);
      setTestMessageText(res.text);
      setComposerFeedback({
        type: "info",
        message: "Template variables rendered for this lead. You can review and edit before sending.",
      });
    } catch (err) {
      setComposerFeedback({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to preview template.",
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleAIPersonalize = async () => {
    if (!lead || !selectedTemplateId) return;
    setIsAIPersonalizing(true);
    setComposerFeedback(null);
    try {
      const res = await previewAIMessage(lead.id, selectedTemplateId);
      setTestMessageText(res.text);
      setComposerFeedback({
        type: "ai",
        message: `AI draft generated via ${res.provider}. Review and edit below before sending.`,
      });
    } catch (err) {
      setComposerFeedback({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to generate AI personalization.",
      });
    } finally {
      setIsAIPersonalizing(false);
    }
  };

  const handleSendMessage = async () => {
    if (!lead || !testMessageText.trim()) return;
    if (!selectedSenderAccountId) {
      setMessageResult({
        success: false,
        status: "FAILED",
        error: {
          code: "SESSION_UNAVAILABLE",
          message:
            "No connected Instagram sender account. Connect an Instagram account first.",
        },
      });
      setShowSendMessageConfirm(false);
      return;
    }

    setIsSendingMessage(true);
    setShowSendMessageConfirm(false);
    setMessageResult(null);

    try {
      const res = await sendSingleMessage(
        lead.id,
        testMessageText.trim(),
        lead.campaignId,
        selectedSenderAccountId,
      );
      if (res.success) {
        setMessageResult({
          success: true,
          status: "SENT",
        });
        setTestMessageText("");
        onLeadUpdated();
      } else {
        const isUnknown = res.status === "UNKNOWN";
        setMessageResult({
          success: false,
          status: isUnknown ? "UNKNOWN" : "FAILED",
          error: {
            code: res.errorCode || (isUnknown ? "UNKNOWN" : "DISPATCH_FAILED"),
            message:
              res.error ||
              (isUnknown
                ? "Delivery could not be confirmed. The message may have been sent."
                : "Message dispatch failed."),
          },
        });
      }

      // Refresh message history
      const history = await getLeadMessages(lead.id);
      setMessageHistory(history);
    } catch (err) {
      setMessageResult({
        success: false,
        status: "FAILED",
        error: {
          code: err instanceof ApiClientError ? err.code : "SEND_ERROR",
          message: err instanceof ApiClientError ? err.message : "Failed to dispatch message.",
        },
      });

      // Refresh history to show any created failed record
      getLeadMessages(lead.id)
        .then(setMessageHistory)
        .catch(() => undefined);
    } finally {
      setIsSendingMessage(false);
    }
  };

  const insertVariable = (varName: string) => {
    setTestMessageText((prev) => (prev ? `${prev} {{${varName}}}` : `{{${varName}}}`));
  };

  const connectedSenders = senders.filter((sender) => sender.isConnected);
  const hasConnectedSender = connectedSenders.length > 0;

  const handleClearDuplicate = async () => {
    if (!lead) return;
    setClearingDuplicate(true);
    try {
      await clearLeadDuplicateFlag(lead.id);
      const refreshed = await getLead(lead.id);
      setLead(refreshed);
    } catch {
      // Non-fatal: the flag simply remains.
    } finally {
      setClearingDuplicate(false);
    }
  };

  const handleFindInstagramHandle = async () => {
    if (!lead) return;
    setIsFindingHandle(true);
    setEnrichFeedback(null);
    try {
      const res = await enrichLeadHandle(lead.id);
      setEnrichFeedback({
        type: res.outcome === "found" ? "success" : "info",
        message: res.message,
      });
      const refreshed = await getLead(lead.id);
      setLead(refreshed);
      onLeadUpdated();
    } catch (err) {
      setEnrichFeedback({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to run handle waterfall.",
      });
    } finally {
      setIsFindingHandle(false);
    }
  };

  const handleEnrichLead = async () => {
    if (!lead) return;
    if (!lead.username || lead.username.trim() === "") {
      return handleFindInstagramHandle();
    }
    setIsEnriching(true);
    setEnrichFeedback(null);
    try {
      const res = await enrichLeads([lead.id]);
      const cachedNotice = res.cachedCount > 0 ? " (from 30-day cache, $0.00)" : "";
      setEnrichFeedback({
        type: "success",
        message: `Profile enriched successfully${cachedNotice}! Cost: $${res.apifyCostUsd.toFixed(4)}. Remaining budget: $${res.remainingBudgetUsd.toFixed(2)}.`,
      });
      const refreshed = await getLead(lead.id);
      setLead(refreshed);
      onLeadUpdated();
    } catch (err) {
      setEnrichFeedback({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to enrich profile.",
      });
    } finally {
      setIsEnriching(false);
    }
  };

  const handleFindContacts = async () => {
    if (!lead) return;
    setIsFindingContacts(true);
    setContactsFeedback(null);
    try {
      const res = await findLeadContacts([lead.id]);
      if (res.leads && res.leads.length > 0) {
        const updated = res.leads[0];
        setLead((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            phone: updated.phone ?? prev.phone,
            phoneNormalized: updated.phoneNormalized ?? prev.phoneNormalized,
            email: updated.email ?? prev.email,
            website: updated.website ?? prev.website,
            rawProfileData: {
              ...(typeof prev.rawProfileData === "object" && prev.rawProfileData !== null ? prev.rawProfileData : {}),
              contacts: updated.contacts,
            },
          };
        });
        const numFound =
          (updated.contacts.emails?.length ?? 0) +
          (updated.contacts.phones?.length ?? 0) +
          (updated.contacts.whatsapps?.length ?? 0);
        setContactsFeedback({
          type: "success",
          message: `Contacts extraction completed: found ${numFound} contact detail(s).`,
        });
        onLeadUpdated();
      }
    } catch (err) {
      setContactsFeedback({
        type: "error",
        message: err instanceof ApiClientError ? err.message : "Failed to extract contacts.",
      });
    } finally {
      setIsFindingContacts(false);
    }
  };

  const formatNumber = (num: number | null) => {
    if (num === null || num === undefined) return "—";
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toLocaleString();
  };

  const getMessageStatusBadge = (status: string) => {
    switch (status) {
      case "SENT":
        return (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
            SENT
          </span>
        );
      case "UNKNOWN":
        return (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
            UNKNOWN
          </span>
        );
      case "SENDING":
        return (
          <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
            SENDING
          </span>
        );
      case "FAILED":
      default:
        return (
          <span className="rounded bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold text-rose-400 border border-rose-500/20">
            FAILED
          </span>
        );
    }
  };

  const getIntentBadge = (intent?: string | null, interestLevel?: string | null) => {
    if (!intent) {
      return (
        <span className="rounded px-1.5 py-0.5 text-[9px] font-medium border border-zinc-700 bg-zinc-800 text-zinc-400">
          Unclassified
        </span>
      );
    }
    const up = intent.toUpperCase();
    let tone = "border-zinc-700 bg-zinc-800 text-zinc-400";
    if (up === "INTERESTED" || up === "PRICE_REQUEST" || up === "MEETING_REQUEST") {
      tone = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    } else if (up === "QUESTION" || up === "FOLLOW_UP_LATER") {
      tone = "border-amber-500/30 bg-amber-500/10 text-amber-300";
    } else if (up === "NOT_INTERESTED") {
      tone = "border-rose-500/30 bg-rose-500/10 text-rose-300";
    }
    return (
      <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold border ${tone}`}>
        {up.replace(/_/g, " ")}{interestLevel ? ` (${interestLevel})` : ""}
      </span>
    );
  };

  const handleClassifyMessage = async (messageId: string) => {
    setClassifyingId(messageId);
    try {
      await classifyMessage(messageId);
      if (leadId) {
        const history = await getLeadMessages(leadId);
        setMessageHistory(history);
      }
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to classify message.");
    } finally {
      setClassifyingId(null);
    }
  };

  const handleApproveReplyDraft = async (draftId: string) => {
    setDraftActionLoading(draftId);
    try {
      await approveDraft(draftId);
      if (leadId) {
        const history = await getLeadMessages(leadId);
        setMessageHistory(history);
      }
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to approve draft.");
    } finally {
      setDraftActionLoading(null);
    }
  };

  const handleRejectReplyDraft = async (draftId: string) => {
    setDraftActionLoading(draftId);
    try {
      await rejectDraft(draftId, { reasonCode: "OTHER" });
      if (leadId) {
        const history = await getLeadMessages(leadId);
        setMessageHistory(history);
      }
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to reject draft.");
    } finally {
      setDraftActionLoading(null);
    }
  };

  const handleSendReplyDraft = async (draftId: string) => {
    setDraftActionLoading(draftId);
    setError(null);
    try {
      const result = await sendReplyDraft(draftId);
      if (result.success) {
        setSuccessMessage("Reply message sent successfully!");
      } else {
        setError(result.error ? `Send failed: ${result.error}` : "Failed to send reply draft.");
      }
      if (leadId) {
        const history = await getLeadMessages(leadId);
        setMessageHistory(history);
      }
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to send reply draft.");
    } finally {
      setDraftActionLoading(null);
    }
  };

  const handleRecordOutcome = async (eventType: "MEETING_BOOKED" | "WON" | "UNSUBSCRIBE_OR_DNC") => {
    if (!lead) return;
    setRecordingOutcome(eventType);
    setError(null);
    try {
      const res = await recordLeadOutcomeEvent(lead.id, eventType);
      setSuccessMessage(
        eventType === "MEETING_BOOKED"
          ? "Meeting booked outcome recorded!"
          : eventType === "WON"
          ? "Won / Deal closed outcome recorded!"
          : "Unsubscribed and added to DNC suppression list."
      );
      setLead({ ...lead, leadStatus: res.leadStatus, status: res.leadStatus });
      onLeadUpdated();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to record outcome event.");
    } finally {
      setRecordingOutcome(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 overflow-hidden">
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
          onClick={onClose}
        />

        <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
          <div className="w-screen max-w-xl border-l border-zinc-800 bg-zinc-900 shadow-2xl flex flex-col">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold tracking-wide uppercase text-zinc-400">
                  Lead Profile
                </span>
                {lead && (
                  <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
                    {lead.source}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {lead && !isEditing && (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsEditing(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-700"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                        />
                      </svg>
                      Edit
                    </button>
                      {lead.email && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleEmailLeadAction("email-reply")}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-900/50 bg-sky-950/40 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-900/60"
                            title="Mark this lead as replied by email (also honors STOP)"
                          >
                            Mark as replied
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEmailLeadAction("email-dnc")}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-900/50 bg-amber-950/40 px-3 py-1.5 text-xs font-medium text-amber-300 transition hover:bg-amber-900/60"
                            title="Add the email address and domain to DNC"
                          >
                            Add to DNC
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-900/50 bg-rose-950/40 px-3 py-1.5 text-xs font-medium text-rose-300 transition hover:bg-rose-900/60"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                      Delete
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Notifications */}
            {error && (
              <div className="mx-6 mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {error}
              </div>
            )}
            {saveSuccess && (
              <div className="mx-6 mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                Lead information updated successfully.
              </div>
            )}
            {successMessage && (
              <div className="mx-6 mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 flex items-center justify-between">
                <span>{successMessage}</span>
                <button
                  type="button"
                  onClick={() => setSuccessMessage(null)}
                  className="text-emerald-400 hover:text-emerald-200 ml-2"
                >
                  ✕
                </button>
              </div>
            )}
            {enrichFeedback && (
              <div
                className={`mx-6 mt-4 rounded-lg border p-3 text-xs flex items-center justify-between ${
                  enrichFeedback.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                <span>{enrichFeedback.message}</span>
                <button
                  type="button"
                  onClick={() => setEnrichFeedback(null)}
                  className="hover:opacity-75 ml-2"
                >
                  ✕
                </button>
              </div>
            )}
            {contactsFeedback && (
              <div
                className={`mx-6 mt-4 rounded-lg border p-3 text-xs flex items-center justify-between ${
                  contactsFeedback.type === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                <span>{contactsFeedback.message}</span>
                <button
                  type="button"
                  onClick={() => setContactsFeedback(null)}
                  className="hover:opacity-75 ml-2"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Drawer Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {!isLoading && lead && (lead.duplicateOfLeadId || lead.possibleDuplicateOfLeadId) && (
                <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                  {lead.duplicateOfLeadId ? (
                    <p>
                      Duplicate lead
                      {lead.duplicateOf?.username ? ` of @${lead.duplicateOf.username}` : ""}
                      {lead.duplicateOf?.id ? ` (${lead.duplicateOf.id})` : ""}. This lead is
                      excluded from messaging.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        Possible duplicate
                        {lead.possibleDuplicateOf?.username
                          ? ` of @${lead.possibleDuplicateOf.username}`
                          : ""}
                        {lead.possibleDuplicateReason
                          ? ` (matched by ${lead.possibleDuplicateReason})`
                          : ""}
                        .
                      </span>
                      <button
                        type="button"
                        onClick={handleClearDuplicate}
                        disabled={clearingDuplicate}
                        className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40"
                      >
                        {clearingDuplicate ? "Clearing..." : "Not a duplicate"}
                      </button>
                    </div>
                  )}
                  {lead._count?.sightings ? (
                    <p className="mt-1 text-amber-300/80">
                      Also found in {lead._count.sightings} campaign sighting(s).
                    </p>
                  ) : null}
                </div>
              )}
              {isLoading ? (
                <div className="space-y-4 animate-pulse">
                  <div className="flex items-center gap-4">
                    <div className="h-16 w-16 rounded-full bg-zinc-800" />
                    <div className="flex-1 space-y-2">
                      <div className="h-5 w-32 rounded bg-zinc-800" />
                      <div className="h-4 w-48 rounded bg-zinc-800" />
                    </div>
                  </div>
                  <div className="h-20 rounded-lg bg-zinc-800" />
                  <div className="h-40 rounded-lg bg-zinc-800" />
                </div>
              ) : lead ? (
                isEditing ? (
                  /* Edit Mode Form */
                  <form onSubmit={handleSave} className="space-y-4">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                      <h4 className="text-sm font-semibold text-zinc-200">Editing Metadata</h4>
                      <span className="text-xs text-zinc-500">Only authorized fields</span>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400">Full Name</label>
                      <input
                        type="text"
                        value={editFullName}
                        onChange={(e) => setEditFullName(e.target.value)}
                        placeholder="Lead full name"
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400">Category / Niche</label>
                      <input
                        type="text"
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        placeholder="e.g. Fitness Model, Creator"
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400">External URL / Website</label>
                      <input
                        type="text"
                        value={editExternalUrl}
                        onChange={(e) => setEditExternalUrl(e.target.value)}
                        placeholder="https://..."
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-400">Biography</label>
                      <textarea
                        rows={4}
                        value={editBiography}
                        onChange={(e) => setEditBiography(e.target.value)}
                        placeholder="Lead bio..."
                        className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex items-center justify-end gap-3 pt-4">
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => setIsEditing(false)}
                        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSaving}
                        className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-rose-500 disabled:opacity-50"
                      >
                        {isSaving && (
                          <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                        )}
                        <span>Save Changes</span>
                      </button>
                    </div>
                  </form>
                ) : (
                  /* View Mode */
                  <div className="space-y-6">
                    {/* User Identity Header */}
                    <div className="flex items-start gap-4">
                      <LeadAvatar
                        profilePicUrlHD={lead.profilePicUrlHD}
                        profilePicUrl={lead.profilePicUrl}
                        profilePictureUrl={lead.profilePictureUrl}
                        username={lead.username}
                        size="lg"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-bold text-zinc-100 truncate">
                            {lead.username ? `@${lead.username}` : (lead.fullName || "Unnamed Lead")}
                          </h3>
                          {!lead.username && (
                            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 border border-zinc-700">
                              NO INSTAGRAM
                            </span>
                          )}
                          {lead.isGroup && (
                            <span className="rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-300 border border-sky-500/20" title={`Group Practice: ${lead.groupKey || ""}`}>
                              GROUP PRACTICE
                            </span>
                          )}
                          {lead.scoreFlags?.includes("NAME_WEBSITE_MISMATCH") && (
                            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/20" title="Business name does not match website domain">
                              NAME/SITE MISMATCH
                            </span>
                          )}
                          {lead.handleSource && (
                            <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 border border-indigo-500/20" title="Handle discovery source and confidence">
                              Source: {lead.handleSource} {lead.handleConfidence ? `(${lead.handleConfidence})` : ""}
                            </span>
                          )}
                          {(lead.verified ?? lead.isVerified) && (
                            <span className="inline-flex items-center text-sky-400" title="Verified Account">
                              <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                              </svg>
                            </span>
                          )}
                          {(lead.isBusinessAccount ?? lead.isBusiness) && (
                            <span className="rounded bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-400 border border-purple-500/20">
                              BUSINESS
                            </span>
                          )}
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-semibold border ${
                              messageHistory.length > 0 && messageHistory[0].status === "SENT"
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                : messageHistory.length > 0 && messageHistory[0].status === "FAILED"
                                ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                                : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                            }`}
                          >
                            {messageHistory.length > 0
                              ? messageHistory[0].status === "SENT"
                                ? "Contacted"
                                : messageHistory[0].status === "FAILED"
                                ? "Failed"
                                : messageHistory[0].status
                              : "New"}
                          </span>
                          {lead.username ? (
                            ((lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" || (!lead.followersCount && !lead.followers && !lead.biography)) ? (
                              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
                                NOT ENRICHED
                              </span>
                            ) : (
                              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                                ENRICHED
                              </span>
                            )
                          ) : null}
                        </div>

                        {lead.fullName && lead.username && (
                          <p className="text-sm font-medium text-zinc-300 truncate">{lead.fullName}</p>
                        )}
                        {!lead.username && (
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className="text-xs text-zinc-500">Available Channels:</span>
                            {lead.email && <span className="rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 px-2 py-0.5 text-[11px] font-medium">{lead.email}</span>}
                            {lead.phone && <span className="rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 px-2 py-0.5 text-[11px] font-medium">{lead.phone}</span>}
                            {lead.website && <span className="rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 px-2 py-0.5 text-[11px] font-medium truncate max-w-[200px]">{lead.website}</span>}
                          </div>
                        )}

                        {(() => {
                          const raw = lead.rawProfileData as
                            | { dataSources?: Record<string, string | null>; alternateEmail?: string; alternatePhone?: string; alternateWebsite?: string }
                            | null
                            | undefined;
                          if (!raw?.dataSources) return null;
                          const parts = Object.entries(raw.dataSources)
                            .filter(([, source]) => Boolean(source))
                            .map(([field, source]) => `${field}: ${source}`);
                          const alternates = [
                            raw.alternateEmail ? `alt email ${raw.alternateEmail}` : null,
                            raw.alternatePhone ? `alt phone ${raw.alternatePhone}` : null,
                            raw.alternateWebsite ? `alt website ${raw.alternateWebsite}` : null,
                          ].filter(Boolean);
                          if (parts.length === 0 && alternates.length === 0) return null;
                          return (
                            <p className="mt-1 text-[10px] text-zinc-500">
                              Field sources: {parts.join(" · ")}
                              {alternates.length > 0 ? ` · ${alternates.join(" · ")}` : ""}
                            </p>
                          );
                        })()}

                        <div className="mt-1 flex items-center gap-3 flex-wrap">
                          {lead.username && lead.profileUrl && (
                            <a
                              href={lead.profileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-rose-400 hover:text-rose-300 transition"
                            >
                              <span>Open Instagram Profile</span>
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                />
                              </svg>
                            </a>
                          )}

                          {!lead.username && (
                            <button
                              type="button"
                              onClick={handleFindInstagramHandle}
                              disabled={isFindingHandle}
                              className="inline-flex items-center gap-1 rounded bg-sky-600/20 border border-sky-500/30 px-2 py-0.5 text-xs font-semibold text-sky-300 hover:bg-sky-600/30 transition disabled:opacity-50"
                              title="Discover Instagram handle from website (homepage, /contact, link hubs)"
                            >
                              <span>⚡ Find Instagram Handle</span>
                              {isFindingHandle && (
                                <svg className="h-3 w-3 animate-spin text-sky-400" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                              )}
                            </button>
                          )}

                          {lead.username && ((lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" || (!lead.followersCount && !lead.followers && !lead.biography)) && (
                            <button
                              type="button"
                              onClick={handleEnrichLead}
                              disabled={isEnriching}
                              className="inline-flex items-center gap-1 rounded bg-rose-600/20 border border-rose-500/30 px-2 py-0.5 text-xs font-semibold text-rose-300 hover:bg-rose-600/30 transition disabled:opacity-50"
                              title="Enrich followers, following, posts, and bio via the active enrichment actor (default apify/instagram-scraper)"
                            >
                              <span>⚡ Enrich Profile</span>
                              <span className="text-[10px] text-rose-400 font-normal">(Est. ~$0.0026)</span>
                              {isEnriching && (
                                <svg className="h-3 w-3 animate-spin text-rose-400" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                              )}
                            </button>
                          )}

                          <button
                            type="button"
                            id="drawer-find-contacts-btn"
                            onClick={handleFindContacts}
                            disabled={isFindingContacts}
                            className="inline-flex items-center gap-1 rounded bg-emerald-600/20 border border-emerald-500/30 px-2 py-0.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/30 transition disabled:opacity-50"
                            title="Extract email, phone, WhatsApp, and social links from bio and website (free Stage 3 extractor)"
                          >
                            <span>🔍 Find Contacts</span>
                            <span className="text-[10px] text-emerald-400 font-normal">(Free)</span>
                            {isFindingContacts && (
                              <svg className="h-3 w-3 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Tab Switcher */}
                    <div className="flex border-b border-zinc-800 bg-zinc-950/40 rounded-lg p-1 gap-1">
                      <button
                        type="button"
                        id="drawer-tab-profile"
                        onClick={() => setActiveTab("profile")}
                        className={`flex-1 py-1.5 px-3 text-xs font-semibold rounded-md transition flex items-center justify-center gap-1.5 ${
                          activeTab === "profile"
                            ? "bg-zinc-800 text-white shadow-xs"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                        <span>Profile Overview</span>
                      </button>
                      <button
                        type="button"
                        id="drawer-tab-message"
                        onClick={() => {
                          if (lead?.username) {
                            setActiveTab("message");
                          }
                        }}
                        disabled={!lead?.username}
                        title={!lead?.username ? "Instagram direct messaging unavailable: No Instagram handle discovered" : undefined}
                        className={`flex-1 py-1.5 px-3 text-xs font-semibold rounded-md transition flex items-center justify-center gap-1.5 ${
                          activeTab === "message"
                            ? "bg-rose-600/20 text-rose-300 border border-rose-500/30 shadow-xs"
                            : !lead?.username
                              ? "text-zinc-600 cursor-not-allowed opacity-50"
                              : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <span>{lead?.username ? `Message @${lead.username}` : "Direct Message (No IG)"}</span>
                        {messageHistory.length > 0 && (
                          <span className="rounded-full bg-zinc-800 px-1.5 py-0.2 text-[9px] text-zinc-300">
                            {messageHistory.length}
                          </span>
                        )}
                      </button>
                    </div>

                    {activeTab === "profile" && (
                      <div className="space-y-6">
                        {/* Transparent Lead Quality Score Card (Step 2 & 4) */}
                        {typeof lead.qualityScore === "number" && (
                          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 shadow-sm space-y-4">
                            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                              <div className="flex items-center gap-2.5">
                                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 font-bold text-xs border border-emerald-500/20">
                                  QS
                                </span>
                                <div>
                                  <div className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                                    Quality Score &amp; Transparency
                                  </div>
                                  <div className="text-[11px] text-zinc-400">
                                    {lead.qualityTier === "A" || lead.qualityScore >= 75
                                      ? "Tier A — High Quality (Priority Outreach)"
                                      : lead.qualityTier === "B" || lead.qualityScore >= 55
                                      ? "Tier B — Good Quality (Eligible for Outreach)"
                                      : lead.qualityTier === "C" || lead.qualityScore >= 35
                                      ? "Tier C — Borderline (Held for Review)"
                                      : "Tier D — Low Quality (Auto-rejected)"}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {lead.isChain && (
                                  <span className="rounded bg-rose-500/10 px-2 py-0.5 text-xs font-bold text-rose-400 border border-rose-500/20">
                                    Chain / Franchise
                                  </span>
                                )}
                                <span
                                  className={`rounded-full px-3 py-1 text-sm font-extrabold border ${
                                    lead.qualityTier === "A" || lead.qualityScore >= 75
                                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                      : lead.qualityTier === "B" || lead.qualityScore >= 55
                                      ? "bg-sky-500/10 text-sky-400 border-sky-500/30"
                                      : lead.qualityTier === "C" || lead.qualityScore >= 35
                                      ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                                      : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                  }`}
                                >
                                  {lead.qualityScore} / 100
                                </span>
                              </div>
                            </div>

                            {/* Flags */}
                            {Array.isArray(lead.scoreFlags) && lead.scoreFlags.length > 0 && (
                              <div>
                                <div className="text-[11px] font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                                  Diagnostic Flags ({lead.scoreFlags.length})
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {lead.scoreFlags.map((flag) => (
                                    <span
                                      key={flag}
                                      className={`rounded px-2 py-0.5 text-[10px] font-semibold border ${
                                        flag.startsWith("UNKNOWN_")
                                          ? "bg-zinc-800/80 text-zinc-400 border-zinc-700"
                                          : flag === "POSSIBLE_CHAIN" || flag === "STALE_INSTAGRAM" || flag === "PRIVATE_ACCOUNT"
                                          ? "bg-rose-500/10 text-rose-300 border-rose-500/20"
                                          : "bg-amber-500/10 text-amber-300 border-amber-500/20"
                                      }`}
                                    >
                                      {flag.replace(/_/g, " ")}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Breakdown categories */}
                            {Array.isArray(lead.scoreBreakdown) && (lead.scoreBreakdown as Array<{
                              category: string;
                              displayName: string;
                              weight: number;
                              points: number;
                              maxPoints: number;
                              skipped: boolean;
                              reasons: string[];
                            }>).length > 0 && (
                              <div className="space-y-2.5 pt-1">
                                <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                                  Weighted Category Breakdown
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                  {(lead.scoreBreakdown as Array<{
                                    category: string;
                                    displayName: string;
                                    weight: number;
                                    points: number;
                                    maxPoints: number;
                                    skipped: boolean;
                                    reasons: string[];
                                  }>).map((cat) => {
                                    const pct = cat.maxPoints > 0 ? Math.round((cat.points / cat.maxPoints) * 100) : 0;
                                    return (
                                      <div
                                        key={cat.category}
                                        className="rounded-lg bg-zinc-950/40 p-2.5 border border-zinc-800/80 text-xs space-y-1.5"
                                      >
                                        <div className="flex items-center justify-between">
                                          <div className="font-semibold text-zinc-200 flex items-center gap-2">
                                            <span>{cat.displayName}</span>
                                            {cat.skipped && (
                                              <span className="text-[10px] text-zinc-500 font-normal italic">
                                                (skipped &amp; re-normalized)
                                              </span>
                                            )}
                                          </div>
                                          <span className="text-[11px] font-bold text-zinc-300">
                                            {cat.points} / {cat.maxPoints} pts ({pct}%)
                                          </span>
                                        </div>
                                        <div className="w-full bg-zinc-800/80 h-1.5 rounded-full overflow-hidden">
                                          <div
                                            className={`h-full rounded-full transition-all ${
                                              pct >= 75
                                                ? "bg-emerald-500"
                                                : pct >= 50
                                                ? "bg-sky-500"
                                                : pct >= 25
                                                ? "bg-amber-500"
                                                : "bg-rose-500"
                                            }`}
                                            style={{ width: `${pct}%` }}
                                          />
                                        </div>
                                        {cat.reasons && cat.reasons.length > 0 && (
                                          <div className="text-[11px] text-zinc-400 pl-1 border-l-2 border-zinc-800 space-y-0.5">
                                            {cat.reasons.map((r, rIdx) => (
                                              <div key={rIdx}>{r}</div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Discovery Origin & Outcome Actions */}
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 shadow-sm space-y-3">
                          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 font-bold text-xs border border-sky-500/20">
                                📍
                              </span>
                              <span className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                                Discovery Origin &amp; Attribution
                              </span>
                            </div>
                            {lead.messageVariant && (
                              <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-bold text-purple-300">
                                Variant {lead.messageVariant}
                              </span>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="rounded-lg bg-zinc-950/40 p-2.5 border border-zinc-800/80">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Keyword</div>
                              <div className="font-semibold text-zinc-200 truncate">{lead.discoveryKeyword || "—"}</div>
                            </div>
                            <div className="rounded-lg bg-zinc-950/40 p-2.5 border border-zinc-800/80">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500">City / Region</div>
                              <div className="font-semibold text-zinc-200 truncate">{lead.discoveryCity || lead.location || "—"}</div>
                            </div>
                            <div className="rounded-lg bg-zinc-950/40 p-2.5 border border-zinc-800/80">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Acquisition Cost</div>
                              <div className="font-semibold text-emerald-400">
                                {lead.acquisitionCostUsd !== undefined && lead.acquisitionCostUsd !== null
                                  ? `$${Number(lead.acquisitionCostUsd).toFixed(4)}`
                                  : "—"}
                              </div>
                            </div>
                            <div className="rounded-lg bg-zinc-950/40 p-2.5 border border-zinc-800/80">
                              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Lead Status</div>
                              <div className="font-semibold text-zinc-200">{lead.leadStatus || lead.status || "NEW"}</div>
                            </div>
                          </div>

                          {/* Manual Outcome Event Actions */}
                          <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                              Record Outcome Event
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                disabled={!!recordingOutcome}
                                onClick={() => handleRecordOutcome("MEETING_BOOKED")}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1.5 text-xs font-semibold text-purple-300 hover:bg-purple-500/20 transition disabled:opacity-50"
                              >
                                <span>📅 Booked Meeting</span>
                              </button>
                              <button
                                type="button"
                                disabled={!!recordingOutcome}
                                onClick={() => handleRecordOutcome("WON")}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-50"
                              >
                                <span>🏆 Won / Closed</span>
                              </button>
                              <button
                                type="button"
                                disabled={!!recordingOutcome}
                                onClick={() => handleRecordOutcome("UNSUBSCRIBE_OR_DNC")}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 transition disabled:opacity-50"
                              >
                                <span>🛑 Unsubscribe / DNC</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* AI Relevance & Analytics */}
                        {(() => {
                          const rawAi = (lead.aiAnalysis || (lead.rawProfileData as Record<string, unknown> | undefined)?.aiAnalysis) as Record<string, unknown> | undefined;
                          const aiScore = lead.leadScore ?? lead.aiScore ?? (typeof rawAi?.score === "number" ? rawAi.score : null);
                          const analytics = (rawAi?.analytics as Record<string, unknown> | undefined) || (rawAi as Record<string, unknown> | undefined);
                          const accountType = (rawAi?.accountType as string) || (analytics?.accountType as string);
                          const reason = (rawAi?.reason as string) || (analytics?.reason as string);
                          const fitReasons = (analytics?.fitReasons as string[]) || [];
                          const riskFlags = (analytics?.riskFlags as string[]) || [];
                          const audienceTier = (analytics?.audienceSizeTier as string);
                          const activityLevel = (analytics?.activityLevel as string);
                          const contactReadiness = (analytics?.contactReadiness as string);

                          if (!rawAi && aiScore === null) return null;

                          return (
                            <div className="rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/40 via-zinc-950/60 to-zinc-900/40 p-4 shadow-sm space-y-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                    </svg>
                                  </span>
                                  <span className="text-xs font-bold uppercase tracking-wider text-indigo-300">
                                    AI Analytics &amp; Fit
                                  </span>
                                </div>
                                {aiScore !== null && (
                                  <span
                                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold border ${
                                      aiScore >= 70
                                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                        : aiScore >= 50
                                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                                        : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                    }`}
                                  >
                                    Score: {aiScore}/100
                                  </span>
                                )}
                              </div>

                              {accountType && (
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="text-zinc-500">Account Type:</span>
                                  <span className="rounded-md bg-zinc-800/80 px-2 py-0.5 font-mono text-[11px] text-zinc-200 border border-zinc-700/50">
                                    {accountType}
                                  </span>
                                </div>
                              )}

                              {reason && (
                                <p className="text-xs text-zinc-300 leading-relaxed bg-zinc-900/60 rounded-lg p-2.5 border border-zinc-800/60">
                                  {reason}
                                </p>
                              )}

                              {(audienceTier || activityLevel || contactReadiness) && (
                                <div className="grid grid-cols-3 gap-2 text-center pt-1">
                                  {audienceTier && (
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                                      <span className="block text-[10px] uppercase tracking-wider text-zinc-500">Audience</span>
                                      <span className="text-xs font-semibold capitalize text-zinc-200">{audienceTier}</span>
                                    </div>
                                  )}
                                  {activityLevel && (
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                                      <span className="block text-[10px] uppercase tracking-wider text-zinc-500">Activity</span>
                                      <span className="text-xs font-semibold capitalize text-zinc-200">{activityLevel}</span>
                                    </div>
                                  )}
                                  {contactReadiness && (
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
                                      <span className="block text-[10px] uppercase tracking-wider text-zinc-500">Contact</span>
                                      <span className="text-xs font-semibold capitalize text-zinc-200">{contactReadiness}</span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {fitReasons.length > 0 && (
                                <div className="space-y-1 pt-1">
                                  <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/90">
                                    Fit Reasons
                                  </span>
                                  <ul className="space-y-1 text-xs text-zinc-300">
                                    {fitReasons.map((fr, idx) => (
                                      <li key={idx} className="flex items-start gap-1.5">
                                        <svg className="h-3.5 w-3.5 shrink-0 text-emerald-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                        <span>{fr}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {riskFlags.length > 0 && (
                                <div className="space-y-1 pt-1">
                                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/90">
                                    Risk Flags
                                  </span>
                                  <ul className="space-y-1 text-xs text-zinc-300">
                                    {riskFlags.map((rf, idx) => (
                                      <li key={idx} className="flex items-start gap-1.5">
                                        <svg className="h-3.5 w-3.5 shrink-0 text-amber-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                        </svg>
                                        <span>{rf}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Audience */}
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                            Audience
                          </span>
                          {((lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" || (!lead.followersCount && !lead.followers && !lead.biography)) && (
                            <span className="text-[10px] text-amber-400 font-medium">
                              Not enriched
                            </span>
                          )}
                        </div>
                    <div className="grid grid-cols-3 gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-center">
                      <div>
                        <span className="text-xs text-zinc-500">Followers</span>
                        <div className="text-base font-bold text-zinc-100">{formatNumber(lead.followersCount ?? lead.followers)}</div>
                      </div>
                      <div className="border-x border-zinc-800">
                        <span className="text-xs text-zinc-500">Following</span>
                        <div className="text-base font-bold text-zinc-100">{formatNumber(lead.followsCount ?? lead.following)}</div>
                      </div>
                      <div>
                        <span className="text-xs text-zinc-500">Posts</span>
                        <div className="text-base font-bold text-zinc-100">{formatNumber(lead.postsCount)}</div>
                      </div>
                    </div>

                    {/* Bio Section */}
                    {lead.biography && (
                      <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-3.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Biography</span>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-200 leading-relaxed font-sans">
                          {lead.biography}
                        </p>
                      </div>
                    )}

                    {/* Content Preview (only when the Actor returned posts) */}
                    {lead.latestPosts && lead.latestPosts.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                          Content Preview
                        </span>
                        <div className="grid grid-cols-3 gap-2">
                          {lead.latestPosts.slice(0, 6).map((post, index) => (
                            <a
                              key={post.id ?? post.shortCode ?? index}
                              href={post.url ?? lead.profileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60"
                              title={post.caption ?? "View post"}
                            >
                              <div className="relative aspect-square bg-zinc-900">
                                {post.displayUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={post.displayUrl}
                                    alt={post.caption ?? "Instagram post"}
                                    className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-600">
                                    No preview
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center justify-between px-1.5 py-1 text-[10px] text-zinc-400">
                                <span>♥ {formatNumber(post.likesCount)}</span>
                                <span>💬 {formatNumber(post.commentsCount)}</span>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Related Profiles (only when returned) */}
                    {lead.relatedProfiles && lead.relatedProfiles.length > 0 && (
                      <div className="space-y-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                          Related Profiles
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {lead.relatedProfiles.slice(0, 8).map((related) => (
                            <a
                              key={related.username}
                              href={`https://www.instagram.com/${related.username}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-950/60 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:border-rose-500/40 hover:text-rose-300"
                            >
                              @{related.username}
                              {related.isVerified && (
                                <svg className="h-3 w-3 fill-sky-400" viewBox="0 0 24 24">
                                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                                </svg>
                              )}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Metadata attributes list */}
                    <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                      Profile &amp; Scrape Data
                    </span>
                    <div className="space-y-3 rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-4 text-xs">
                      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                        <span className="text-zinc-500">Category</span>
                        <span className="font-medium text-zinc-200">{lead.businessCategoryName || lead.category || "Uncategorized"}</span>
                      </div>

                      {lead.location && (
                        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                          <span className="text-zinc-500">Location</span>
                          <span className="font-medium text-zinc-200">{lead.location}</span>
                        </div>
                      )}

                      {(() => {
                        const raw = lead.rawProfileData as Record<string, unknown> | undefined;
                        const locConf = (raw?.locationConfidence as string) || (lead as { locationConfidence?: string }).locationConfidence;
                        const fieldSources = (raw?.fieldSources as Record<string, string>) || (lead as { fieldSources?: Record<string, string> }).fieldSources;
                        const mapsUrl = (raw?.mapsUrl as string) || (lead as { mapsUrl?: string }).mapsUrl;

                        return (
                          <>
                            {locConf && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="text-zinc-500">Location Confidence</span>
                                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                                  locConf === "high" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                }`}>
                                  {locConf}
                                </span>
                              </div>
                            )}
                            {mapsUrl && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="text-zinc-500">Google Maps</span>
                                <a href={mapsUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline truncate max-w-[200px]">
                                  View on Maps
                                </a>
                              </div>
                            )}
                            {fieldSources && Object.keys(fieldSources).length > 0 && (
                              <div className="border-b border-zinc-800/60 pb-2">
                                <span className="text-zinc-500 block mb-1">Field Sources</span>
                                <div className="grid grid-cols-2 gap-1 text-[10px] text-zinc-400 font-mono">
                                  {Object.entries(fieldSources).map(([f, s]) => (
                                    <div key={f} className="truncate">
                                      <span className="text-zinc-500">{f}:</span> {s}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}

                      {lead.instagramId && (
                        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                          <span className="text-zinc-500">Instagram ID</span>
                          <span className="font-mono text-[11px] text-zinc-400">
                            {lead.instagramId}
                          </span>
                        </div>
                      )}

                      {/* Extracted Contacts list (emails, phones, whatsapp with source tags) */}
                      {(() => {
                        const contactsObj = (lead.rawProfileData as { contacts?: LeadContactsInfo } | undefined)?.contacts;
                        const emails = contactsObj?.emails ?? (lead.email ? [{ value: lead.email, source: "bio" as const }] : []);
                        const phones = contactsObj?.phones ?? (lead.phone ? [{ value: lead.phone, normalized: lead.phoneNormalized || lead.phone, source: "bio" as const }] : []);
                        const whatsapps = contactsObj?.whatsapps ?? [];

                        return (
                          <>
                            {emails.map((em, idx) => (
                              <div key={`email-${idx}`} className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-zinc-500">Email</span>
                                  <span className={`rounded px-1.5 py-0.2 text-[9px] uppercase font-semibold border ${
                                    em.source === "bio"
                                      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                      : em.source === "website"
                                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                      : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                  }`}>
                                    {em.source}
                                  </span>
                                </div>
                                <a
                                  href={`mailto:${em.value}`}
                                  className="max-w-[240px] truncate text-emerald-400 hover:underline"
                                >
                                  {em.value}
                                </a>
                              </div>
                            ))}

                            {phones.map((ph, idx) => (
                              <div key={`phone-${idx}`} className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-zinc-500">Phone</span>
                                  <span className={`rounded px-1.5 py-0.2 text-[9px] uppercase font-semibold border ${
                                    ph.source === "bio"
                                      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                      : ph.source === "website"
                                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                      : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                  }`}>
                                    {ph.source}
                                  </span>
                                </div>
                                <a
                                  href={`tel:${ph.normalized || ph.value}`}
                                  className="max-w-[240px] truncate text-cyan-400 hover:underline"
                                  title={`E.164: ${ph.normalized}`}
                                >
                                  {ph.normalized || ph.value}
                                </a>
                              </div>
                            ))}

                            {whatsapps.map((wa, idx) => (
                              <div key={`wa-${idx}`} className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-zinc-500">WhatsApp</span>
                                  <span className={`rounded px-1.5 py-0.2 text-[9px] uppercase font-semibold border ${
                                    wa.source === "bio"
                                      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                      : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  }`}>
                                    {wa.source}
                                  </span>
                                </div>
                                <a
                                  href={wa.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="max-w-[240px] truncate text-emerald-400 hover:underline"
                                >
                                  {wa.phone ? `Chat (${wa.phone})` : wa.url.replace(/^https?:\/\//, "")}
                                </a>
                              </div>
                            ))}
                          </>
                        );
                      })()}

                      {(() => {
                        const linkInfo = getLeadLinkClassification(lead);
                        return (
                          <>
                            {linkInfo.hasWebsite && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="flex items-center gap-1.5 text-zinc-500">
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                  </svg>
                                  Website
                                </span>
                                <a
                                  href={linkInfo.website!.startsWith("http") ? linkInfo.website! : `https://${linkInfo.website}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="max-w-[240px] truncate text-emerald-400 hover:underline"
                                >
                                  {linkInfo.website}
                                </a>
                              </div>
                            )}
                            {linkInfo.hasSocialLink && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="flex items-center gap-1.5 text-zinc-500">
                                  <span className="text-zinc-400">
                                    <SocialPlatformIcon platform={linkInfo.socialPlatform || "social"} className="h-3.5 w-3.5" />
                                  </span>
                                  {linkInfo.socialLabel}
                                </span>
                                <a
                                  href={linkInfo.socialLink!.startsWith("http") ? linkInfo.socialLink! : `https://${linkInfo.socialLink}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="max-w-[240px] truncate text-sky-400 hover:underline"
                                >
                                  {linkInfo.socialLink}
                                </a>
                              </div>
                            )}
                          </>
                        );
                      })()}

                      {/* Other Social Links discovered from Website HTML */}
                      {(() => {
                        const socials = (lead.rawProfileData as { socialLinks?: Record<string, string | null> } | undefined)?.socialLinks;
                        if (!socials) return null;
                        const entries = Object.entries(socials).filter((entry) => Boolean(entry[1]));
                        if (entries.length === 0) return null;
                        return (
                          <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                            <span className="text-zinc-500">Other Socials</span>
                            <div className="flex gap-1.5 items-center flex-wrap justify-end">
                              {entries.map(([platform, url]) => (
                                <a
                                  key={platform}
                                  href={url!.startsWith("http") ? url! : `https://${url}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:text-rose-400 border border-zinc-700/60 transition"
                                  title={`Open ${platform}`}
                                >
                                  <SocialPlatformIcon platform={platform} className="h-3 w-3" />
                                  <span className="capitalize">{platform}</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Maps Details */}
                      {(() => {
                        const raw = lead.rawProfileData as { rating?: number; reviewsCount?: number; mapsCategory?: string } | undefined;
                        if (!raw?.rating && !raw?.mapsCategory) return null;
                        return (
                          <>
                            {raw.mapsCategory && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="text-zinc-500">Maps Category</span>
                                <span className="font-medium text-zinc-200">{raw.mapsCategory}</span>
                              </div>
                            )}
                            {raw.rating && (
                              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                                <span className="text-zinc-500">Maps Rating</span>
                                <span className="font-medium text-amber-400">
                                  ★ {raw.rating} {raw.reviewsCount ? `(${raw.reviewsCount} reviews)` : ""}
                                </span>
                              </div>
                            )}
                          </>
                        );
                      })()}

                      {/* Enrichment Status */}
                      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                        <span className="text-zinc-500">Enrichment</span>
                        <div className="flex items-center gap-2">
                          {((lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" || (!lead.followersCount && !lead.followers && !lead.biography)) ? (
                            <>
                              <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/20">
                                Not Enriched
                              </span>
                              <button
                                type="button"
                                onClick={handleEnrichLead}
                                disabled={isEnriching}
                                className="rounded bg-rose-600/20 px-2 py-0.5 text-[10px] font-medium text-rose-300 border border-rose-500/30 hover:bg-rose-600/30 transition"
                              >
                                {isEnriching ? "..." : "Enrich (~$0.0026)"}
                              </button>
                            </>
                          ) : (
                            <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                              Enriched
                            </span>
                          )}
                        </div>
                      </div>

                      {lead.contactSource && (
                        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                          <span className="text-zinc-500">Contact Source</span>
                          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
                            {lead.contactSource}
                          </span>
                        </div>
                      )}

                      {lead.availableChannels && lead.availableChannels.length > 0 && (() => {
                        const linkInfo = getLeadLinkClassification(lead);
                        const filteredChannels = lead.availableChannels.filter(
                          (ch) => ch.toUpperCase() !== "WEBSITE" || linkInfo.hasWebsite
                        );
                        if (filteredChannels.length === 0) return null;
                        return (
                          <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                            <span className="text-zinc-500">Channels</span>
                            <div className="flex gap-1.5 flex-wrap">
                              {filteredChannels.map((ch) => (
                                <span
                                  key={ch}
                                  className="rounded bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300"
                                >
                                  {ch}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                        <span className="text-zinc-500">Scraped At</span>
                        <span className="font-medium text-zinc-300">
                          {lead.scrapedAt ? new Date(lead.scrapedAt).toLocaleString() : "—"}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500">Lead ID</span>
                        <span className="font-mono text-[11px] text-zinc-400">{lead.id}</span>
                      </div>
                    </div>

                    {/* Collapsible Additional Profile Data */}
                    <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 overflow-hidden">
                      <button
                        type="button"
                        id="toggle-additional-profile-data"
                        onClick={() => setShowAdditionalData(!showAdditionalData)}
                        className="w-full flex items-center justify-between p-3.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition"
                      >
                        <span className="uppercase tracking-wider">Additional Profile Data</span>
                        <span className="text-[11px] text-zinc-500 font-normal">
                          {showAdditionalData ? "Hide ▲" : "Show Details ▼"}
                        </span>
                      </button>
                      {showAdditionalData && (
                        <div className="border-t border-zinc-800/60 p-4 space-y-2.5 text-xs">
                          {lead.profilePicUrlHD && (
                            <div className="flex items-center justify-between">
                              <span className="text-zinc-500">HD Profile Picture</span>
                              <a
                                href={lead.profilePicUrlHD}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-rose-400 hover:underline inline-flex items-center gap-1"
                              >
                                <span>View Full HD Picture</span>
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            </div>
                          )}
                          {lead.rawProfileData && typeof lead.rawProfileData === "object" && (
                            <>
                              {"isPrivate" in lead.rawProfileData && (
                                <div className="flex items-center justify-between">
                                  <span className="text-zinc-500">Account Privacy</span>
                                  <span className="font-medium text-zinc-300">
                                    {lead.rawProfileData.isPrivate ? "Private" : "Public"}
                                  </span>
                                </div>
                              )}
                              {"highlightReelCount" in lead.rawProfileData && lead.rawProfileData.highlightReelCount !== null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-zinc-500">Highlight Reels</span>
                                  <span className="font-medium text-zinc-300">
                                    {String(lead.rawProfileData.highlightReelCount)}
                                  </span>
                                </div>
                              )}
                              {"joinedRecently" in lead.rawProfileData && lead.rawProfileData.joinedRecently !== null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-zinc-500">Joined Recently</span>
                                  <span className="font-medium text-zinc-300">
                                    {lead.rawProfileData.joinedRecently ? "Yes" : "No"}
                                  </span>
                                </div>
                              )}
                              {"hasChannel" in lead.rawProfileData && lead.rawProfileData.hasChannel !== null && (
                                <div className="flex items-center justify-between">
                                  <span className="text-zinc-500">Broadcast Channel</span>
                                  <span className="font-medium text-zinc-300">
                                    {lead.rawProfileData.hasChannel ? "Yes" : "No"}
                                  </span>
                                </div>
                              )}
                            </>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-zinc-500">Data Source</span>
                            <span className="font-medium text-zinc-300">{lead.source}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Quick switch to message tab */}
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => setActiveTab("message")}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600/10 border border-rose-500/20 py-2.5 px-4 text-xs font-semibold text-rose-400 hover:bg-rose-600/20 hover:text-rose-300 transition"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                        <span>Compose Message to @{lead.username}</span>
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "message" && (
                  <div className="space-y-4">
                    {/* Auto-suggest enrichment only for leads about to get a DM draft */}
                    {((lead.rawProfileData as { enrichmentStatus?: string } | undefined)?.enrichmentStatus === "NOT_ENRICHED" || (!lead.followersCount && !lead.followers && !lead.biography)) && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
                        <div className="flex items-center gap-2.5">
                          <span className="text-xl">💡</span>
                          <div>
                            <p className="font-semibold text-amber-100">Enrich profile first for better AI personalization?</p>
                            <p className="text-[11px] text-amber-300/80">Fetching bio and post history helps generate personalized, higher-converting DM drafts (Est. ~$0.0026).</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={handleEnrichLead}
                          disabled={isEnriching}
                          className="shrink-0 rounded-lg bg-amber-500/20 border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 transition disabled:opacity-50 flex items-center gap-1.5"
                        >
                          {isEnriching ? "Enriching via Apify..." : "⚡ Enrich Profile (~$0.0026)"}
                        </button>
                      </div>
                    )}

                    {/* Section: Controlled Single-Recipient Message */}
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-4">
                      <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                        <div className="flex items-center gap-2">
                          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-500/10 text-rose-400">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                              />
                            </svg>
                          </div>
                          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                            Send to @{lead.username}
                          </h4>
                        </div>

                        {providerStatus && (
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span className="text-zinc-500 font-mono uppercase">Provider:</span>
                            {providerStatus.status === "READY" ? (
                              <span className="rounded bg-emerald-500/10 px-2 py-0.5 font-semibold text-emerald-400 border border-emerald-500/20">
                                {providerStatus.provider.toUpperCase()} READY
                              </span>
                            ) : (
                              <span
                                className="rounded bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-400 border border-amber-500/20"
                                title={providerStatus.message}
                              >
                                AUTH REQUIRED
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        Send <strong className="text-zinc-200">ONE</strong> live direct message to{" "}
                        <strong className="text-rose-400">@{lead.username}</strong> via the connected Instagram sender account. Mass/bulk automated sending is strictly disabled.
                      </p>


                          {/* Sender Account Selector */}
                          <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/70 p-3 space-y-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <label
                            htmlFor="single-sender-select"
                            className="text-[11px] font-bold uppercase tracking-wider text-zinc-300"
                          >
                            Sender
                          </label>
                          {!hasConnectedSender && (
                            <span className="text-[10px] text-amber-400">
                              No connected Instagram sender account. Connect an Instagram account first.
                            </span>
                          )}
                        </div>
                        <select
                          id="single-sender-select"
                          value={selectedSenderAccountId}
                          disabled={!hasConnectedSender || isSendingMessage}
                          onChange={(e) => setSelectedSenderAccountId(e.target.value)}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                        >
                          {!hasConnectedSender ? (
                            <option value="">No connected sender account</option>
                          ) : (
                            connectedSenders.map((sender) => (
                              <option key={sender.id} value={sender.id}>
                                @{sender.username}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      {/* Template Selector & AI Personalization Controls */}
                      <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/70 p-3 space-y-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">
                            Message Template
                          </label>
                          {templates.length === 0 && !isLoadingTemplates && (
                            <span className="text-[10px] text-zinc-500">
                              No templates in this campaign yet
                            </span>
                          )}
                        </div>

                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <select
                            value={selectedTemplateId}
                            disabled={isLoadingTemplates || templates.length === 0}
                            onChange={(e) => {
                              setSelectedTemplateId(e.target.value);
                              setComposerFeedback(null);
                            }}
                            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-200 focus:border-rose-500 focus:outline-none disabled:opacity-50"
                          >
                            {templates.length === 0 ? (
                              <option value="">No templates available</option>
                            ) : (
                              templates.map((tmpl) => (
                                <option key={tmpl.id} value={tmpl.id}>
                                  {tmpl.name} {tmpl.campaignId === null ? "(Global)" : ""}
                                </option>
                              ))
                            )}
                          </select>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              id="btn-preview-template"
                              disabled={!selectedTemplateId || isPreviewing || isAIPersonalizing}
                              onClick={handlePreviewTemplate}
                              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition disabled:opacity-40"
                            >
                              {isPreviewing ? (
                                <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                              ) : (
                                <svg className="h-3 w-3 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                              )}
                              <span>Preview</span>
                            </button>

                            <button
                              type="button"
                              id="btn-ai-personalize"
                              disabled={!selectedTemplateId || isAIPersonalizing || isPreviewing}
                              onClick={handleAIPersonalize}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-950/60 px-3 py-1.5 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/60 hover:text-indigo-200 transition disabled:opacity-40"
                            >
                              {isAIPersonalizing ? (
                                <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                              ) : (
                                <svg className="h-3 w-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                              )}
                              <span>AI Personalize</span>
                            </button>
                          </div>
                        </div>

                        {/* Safety notice banner */}
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 bg-zinc-950/40 rounded-md p-2 border border-zinc-800/60">
                          <svg className="h-3.5 w-3.5 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span>
                            Template rendered messages can be freely edited below. No automated dispatch will occur without your explicit confirmation.
                          </span>
                        </div>
                      </div>

                      {/* Variable Quick-Insert Chips */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] text-zinc-500 font-medium">Insert Variable:</span>
                        {[
                          { label: "firstName", key: "firstName" },
                          { label: "username", key: "username" },
                          { label: "category", key: "category" },
                          { label: "fullName", key: "fullName" },
                          { label: "followersCount", key: "followersCount" },
                        ].map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            onClick={() => insertVariable(v.key)}
                            className="rounded bg-zinc-800/80 px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:bg-zinc-700 hover:text-white transition border border-zinc-700/60"
                            title={`Insert {{${v.key}}}`}
                          >
                            + {`{{${v.label}}}`}
                          </button>
                        ))}
                      </div>

                      {/* Composer Feedback Banner */}
                      {composerFeedback && (
                        <div
                          className={`rounded-lg p-2.5 text-xs border ${
                            composerFeedback.type === "ai"
                              ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                              : composerFeedback.type === "info"
                              ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                              : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 font-medium text-[11px]">
                            {composerFeedback.type === "ai" ? (
                              <span>✨ {composerFeedback.message}</span>
                            ) : composerFeedback.type === "info" ? (
                              <span>ℹ️ {composerFeedback.message}</span>
                            ) : (
                              <span>⚠️ {composerFeedback.message}</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Result Feedback Banner */}
                      {messageResult && (
                        <div
                          className={`rounded-lg p-3 text-xs border ${
                            messageResult.success
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                          }`}
                        >
                          <div className="font-semibold flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              {messageResult.success ? (
                                <>
                                  <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  <span>Message sent to @{lead.username}</span>
                                </>
                              ) : (
                                <>
                                  <svg className="h-4 w-4 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                  <span>Message was not sent ({messageResult.error?.code || "FAILED"})</span>
                                </>
                              )}
                            </div>
                            {!messageResult.success && (
                              <button
                                type="button"
                                onClick={() => setShowSendMessageConfirm(true)}
                                className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-rose-500 transition"
                              >
                                Retry
                              </button>
                            )}
                          </div>
                          {!messageResult.success && messageResult.error && (
                            <p className="mt-1 text-rose-200/90 text-[11px]">{messageResult.error.message}</p>
                          )}
                        </div>
                      )}

                      {/* Message Input Form */}
                      <div className="space-y-3">
                        <textarea
                          rows={4}
                          value={testMessageText}
                          disabled={isSendingMessage}
                          onChange={(e) => setTestMessageText(e.target.value)}
                          placeholder="Select a template above, click Preview or AI Personalize, or type your outreach message directly..."
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-rose-500 focus:outline-none disabled:opacity-50 font-sans leading-relaxed"
                        />

                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-zinc-500">
                            {testMessageText.length}/1000 characters
                          </span>
                          {(() => {
                            const isDryRun =
                              lead?.source === "dry_run" ||
                              lead?.source === "sample" ||
                              (lead?.username || "").startsWith("sample_");
                            const hasNoHandle = !lead?.username || lead.username.trim() === "";
                            return (
                              <button
                                type="button"
                                disabled={
                                  !sendingEnabled ||
                                  isDryRun ||
                                  hasNoHandle ||
                                  isSendingMessage ||
                                  !testMessageText.trim() ||
                                  !hasConnectedSender
                                }
                                title={
                                  !sendingEnabled
                                    ? "Sending is OFF - discovery only (OUTBOUND_SENDING_ENABLED=false)"
                                    : isDryRun
                                      ? "Cannot send to dry-run or sample lead"
                                      : hasNoHandle
                                        ? "Cannot send Instagram DM: Lead has no Instagram handle"
                                        : undefined
                                }
                                onClick={() => setShowSendMessageConfirm(true)}
                                id="send-test-message-btn"
                                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-500 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {isSendingMessage ? (
                                  <>
                                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path
                                        className="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                      />
                                    </svg>
                                    <span>Sending to @{lead?.username || "recipient"}...</span>
                                  </>
                                ) : (
                                  <span>{hasNoHandle ? "No Instagram Handle" : `Send to @${lead?.username}`}</span>
                                )}
                              </button>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Step 6: AI draft + review status */}
                      <LeadDraftsPanel leadId={leadId} />

                      {/* Message History for this Lead */}
                      <div className="border-t border-zinc-800 pt-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                            Message Audit History ({messageHistory.length})
                          </span>
                          {isLoadingHistory && (
                            <span className="text-[10px] text-zinc-500 animate-pulse">Loading history...</span>
                          )}
                        </div>

                        {messageHistory.length === 0 ? (
                          <p className="text-[11px] text-zinc-600 italic">No previous messages sent to this lead.</p>
                        ) : (
                          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                            {messageHistory.map((msg) => (
                              <div
                                key={msg.id}
                                className="rounded-lg border border-zinc-800/80 bg-zinc-900/80 p-2.5 text-xs space-y-1.5"
                              >
                                <div className="flex items-center justify-between text-[10px]">
                                  <div className="flex items-center gap-1.5">
                                    {getMessageStatusBadge(msg.status)}
                                    {msg.direction && (
                                      <span
                                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold border ${
                                          msg.direction === "INBOUND"
                                            ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
                                            : "border-zinc-700 bg-zinc-800 text-zinc-400"
                                        }`}
                                      >
                                        {msg.direction}
                                      </span>
                                    )}
                                    {msg.direction === "INBOUND" && getIntentBadge(msg.intent, msg.interestLevel)}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {msg.direction === "INBOUND" && (
                                      <button
                                        type="button"
                                        disabled={classifyingId === msg.id}
                                        onClick={() => void handleClassifyMessage(msg.id)}
                                        className="text-[10px] text-zinc-400 hover:text-zinc-200 underline font-medium disabled:opacity-50"
                                      >
                                        {classifyingId === msg.id
                                          ? "Classifying..."
                                          : msg.intent
                                          ? "Re-classify"
                                          : "Classify"}
                                      </button>
                                    )}
                                    <span className="text-zinc-500">
                                      {new Date(msg.createdAt).toLocaleString()}
                                    </span>
                                  </div>
                                </div>
                                <p className="text-zinc-200 text-xs line-clamp-3">{msg.messageText}</p>
                                {msg.errorMessage && (
                                  <p className="text-[10px] text-rose-400/90 font-mono truncate">
                                    Error: {msg.errorMessage}
                                  </p>
                                )}
                                {msg.replyDrafts && msg.replyDrafts.length > 0 && (
                                  <div className="mt-2 space-y-1.5">
                                    {msg.replyDrafts.map((draft) => (
                                      <div
                                        key={draft.id}
                                        className="rounded-md border border-zinc-700/60 bg-zinc-950/70 p-2 space-y-1.5 text-xs"
                                      >
                                        <div className="flex items-center justify-between text-[10px]">
                                          <div className="flex items-center gap-1.5">
                                            <span className="font-semibold text-zinc-300">Suggested Reply</span>
                                            <span
                                              className={`rounded-full border px-1.5 py-0.2 text-[9px] font-medium ${
                                                draft.status === "APPROVED"
                                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                                                  : draft.status === "BLOCKED"
                                                  ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                                                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                                              }`}
                                            >
                                              {draft.status}
                                            </span>
                                            {draft.qualityScore !== null && draft.qualityScore !== undefined && (
                                              <span className="text-zinc-500 text-[9px]">Score: {draft.qualityScore}</span>
                                            )}
                                          </div>
                                          <div className="flex items-center gap-1">
                                            {draft.status === "PENDING_REVIEW" && (
                                              <>
                                                <button
                                                  type="button"
                                                  disabled={draftActionLoading === draft.id}
                                                  onClick={() => void handleApproveReplyDraft(draft.id)}
                                                  className="rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 px-1.5 py-0.5 text-[9px] font-semibold border border-emerald-500/30 disabled:opacity-50"
                                                >
                                                  Approve
                                                </button>
                                                <button
                                                  type="button"
                                                  disabled={draftActionLoading === draft.id}
                                                  onClick={() => void handleRejectReplyDraft(draft.id)}
                                                  className="rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 px-1.5 py-0.5 text-[9px] font-semibold border border-rose-500/30 disabled:opacity-50"
                                                >
                                                  Reject
                                                </button>
                                              </>
                                            )}
                                            {draft.status === "APPROVED" && (
                                              <button
                                                type="button"
                                                disabled={draftActionLoading === draft.id}
                                                onClick={() => void handleSendReplyDraft(draft.id)}
                                                className="rounded bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 text-[9px] font-semibold disabled:opacity-50 shadow-xs flex items-center gap-1"
                                              >
                                                {draftActionLoading === draft.id ? "Sending..." : "Send"}
                                              </button>
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setTestMessageText(draft.body);
                                                setActiveTab("message");
                                              }}
                                              className="rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-1.5 py-0.5 text-[9px] font-medium border border-zinc-700"
                                            >
                                              Use in Composer
                                            </button>
                                          </div>
                                        </div>
                                        <p className="text-zinc-200 text-xs whitespace-pre-wrap">{draft.body}</p>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {msg.status === "FAILED" && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setTestMessageText(msg.messageText);
                                      setActiveTab("message");
                                    }}
                                    className="text-[10px] text-rose-400 hover:underline font-medium block pt-0.5"
                                  >
                                    Load into composer to retry
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Section: Follow-up Timeline */}
                    {lead.followUpMessages && lead.followUpMessages.length > 0 && (
                      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
                        <div className="flex items-center justify-between border-b border-zinc-800 pb-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-400">
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </div>
                            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                              Scheduled Follow-ups ({lead.followUpMessages.length})
                            </h4>
                          </div>
                        </div>

                        <div className="space-y-2">
                          {lead.followUpMessages.map((fu) => {
                            const statusBadgeStyle =
                              fu.status === "SCHEDULED"
                                ? "border-sky-500/30 bg-sky-500/10 text-sky-400"
                                : fu.status === "SENT"
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                : fu.status === "CANCELLED_REPLIED"
                                ? "border-purple-500/30 bg-purple-500/10 text-purple-300"
                                : fu.status === "CANCELLED_DNC"
                                ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                                : fu.status === "NEEDS_EDIT"
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                : fu.status === "FAILED"
                                ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                                : "border-zinc-700 bg-zinc-800 text-zinc-300";

                            return (
                              <div
                                key={fu.id}
                                className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3 space-y-2"
                              >
                                <div className="flex items-center justify-between text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-zinc-200">Follow-up #{fu.step}</span>
                                    <span
                                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusBadgeStyle}`}
                                    >
                                      {fu.status}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-zinc-400">
                                    {fu.status === "SENT" && fu.sentAt ? (
                                      <span>Sent: {new Date(fu.sentAt).toLocaleString()}</span>
                                    ) : fu.status === "SCHEDULED" ? (
                                      <span>Due: {new Date(fu.dueAt).toLocaleString()}</span>
                                    ) : (
                                      <span>Due was: {new Date(fu.dueAt).toLocaleDateString()}</span>
                                    )}
                                  </div>
                                </div>

                                <p className="text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/60 font-sans">
                                  {fu.renderedBody || fu.templateText}
                                </p>

                                {fu.cancelReason && (
                                  <p className="text-[11px] text-zinc-400 italic">
                                    Reason: {fu.cancelReason}
                                  </p>
                                )}
                                {fu.errorMessage && (
                                  <p className="text-[11px] text-rose-400 font-mono">
                                    Error: {fu.errorMessage}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )) : null}


            </div>
          </div>
        </div>
      </div>

      {/* Delete Lead Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Lead"
        message={`Are you sure you want to delete ${lead?.username ? `@${lead.username}` : (lead?.fullName || "this lead")}? This action cannot be undone.`}
        confirmLabel="Delete Lead"
        isDangerous={true}
        isLoading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* Send Message Confirmation Modal */}
      <ConfirmModal
        isOpen={showSendMessageConfirm}
        title={`Send Message to @${lead?.username || ""}`}
        message={`Recipient: @${lead?.username || ""}\n\nMessage preview:\n"${testMessageText.trim()}"\n\nAre you sure you want to dispatch this message via the authenticated Instagram browser session?`}
        confirmLabel={`Send to @${lead?.username || ""}`}
        cancelLabel="Cancel"
        isDangerous={false}
        isLoading={isSendingMessage}
        onConfirm={handleSendMessage}
        onCancel={() => setShowSendMessageConfirm(false)}
      />

    </>
  );
}
