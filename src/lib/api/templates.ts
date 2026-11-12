import { apiFetch } from "./client";

export type MessageTemplate = {
  id: string;
  campaignId: string | null;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateTemplateInput = {
  name: string;
  body: string;
};

export type UpdateTemplateInput = {
  name?: string;
  body?: string;
};

export type MessagePreviewResult = {
  text: string;
};

export type AIPreviewResult = {
  text: string;
  provider: string;
  generated: true;
};

export async function getCampaignTemplates(
  campaignId: string,
): Promise<MessageTemplate[]> {
  return apiFetch<MessageTemplate[]>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/templates`,
  );
}

export async function createCampaignTemplate(
  campaignId: string,
  input: CreateTemplateInput,
): Promise<MessageTemplate> {
  return apiFetch<MessageTemplate>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/templates`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function updateTemplate(
  templateId: string,
  input: UpdateTemplateInput,
): Promise<MessageTemplate> {
  return apiFetch<MessageTemplate>(
    `/api/templates/${encodeURIComponent(templateId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteTemplate(
  templateId: string,
): Promise<{ id: string; deleted: true }> {
  return apiFetch<{ id: string; deleted: true }>(
    `/api/templates/${encodeURIComponent(templateId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function previewTemplateMessage(
  leadId: string,
  templateId: string,
  campaignContext?: string,
): Promise<MessagePreviewResult> {
  return apiFetch<MessagePreviewResult>("/api/messages/preview", {
    method: "POST",
    body: JSON.stringify({ leadId, templateId, campaignContext }),
  });
}

export type TemplateLeadPreview = {
  lead: {
    id: string;
    username: string | null;
    fullName: string | null;
    profileUrl: string | null;
    profilePictureUrl: string | null;
    isVerified: boolean | null;
    isBusiness: boolean | null;
    category: string | null;
    followers: number | null;
    following: number | null;
    postsCount: number | null;
    externalUrl: string | null;
  };
  text: string;
  missingVariables: string[];
};

export type TemplateLeadsPreviewResult = {
  template: { id: string; name: string; body: string };
  campaign: { id: string; name: string };
  sent: false;
  previews: TemplateLeadPreview[];
};

export async function previewTemplateLeads(
  templateId: string,
  campaignId: string,
  leadIds: string[],
): Promise<TemplateLeadsPreviewResult> {
  return apiFetch<TemplateLeadsPreviewResult>(
    `/api/templates/${encodeURIComponent(templateId)}/preview`,
    {
      method: "POST",
      body: JSON.stringify({ campaignId, leadIds }),
    },
  );
}

export async function previewAIMessage(
  leadId: string,
  templateId: string,
  campaignContext?: string,
): Promise<AIPreviewResult> {
  return apiFetch<AIPreviewResult>("/api/messages/ai-preview", {
    method: "POST",
    body: JSON.stringify({ leadId, templateId, campaignContext }),
  });
}

export type TemplateSuggestionItem = {
  id: string;
  name: string;
  angle: "curiosity" | "value_offer" | "collaboration" | "direct_inquiry";
  label: string;
  body: string;
  description: string;
};

export type CampaignTemplateSuggestionsResult = {
  campaignName: string;
  intent: string;
  suggestions: TemplateSuggestionItem[];
};

export async function getCampaignTemplateSuggestions(
  campaignId: string,
  customIntent?: string,
): Promise<CampaignTemplateSuggestionsResult> {
  return apiFetch<CampaignTemplateSuggestionsResult>(
    `/api/campaigns/${encodeURIComponent(campaignId)}/templates/suggest`,
    {
      method: "POST",
      body: JSON.stringify({ intent: customIntent }),
    },
  );
}
