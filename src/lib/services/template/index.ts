export {
  MAX_PREVIEW_LEADS,
  MAX_TEMPLATE_BODY_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
} from "./template-constants";

export {
  SUPPORTED_TEMPLATE_VARIABLES,
  SUPPORTED_VARIABLES_SET,
  TEMPLATE_VARIABLE_ALIASES,
  TEMPLATE_VARIABLE_DEFINITIONS,
  extractTemplateVariables,
  renderTemplate,
  renderTemplateDetailed,
  resolveFirstName,
  validateTemplateVariables,
  type RenderedTemplate,
  type TemplateLeadContext,
  type TemplateVariableDefinition,
} from "./template-renderer";

export {
  createCampaignTemplate,
  deleteTemplate,
  getTemplateById,
  listCampaignTemplates,
  previewTemplateForLeads,
  updateTemplate,
  generateCampaignTemplateSuggestions,
  type MessageTemplateSummary,
  type TemplateLeadPreview,
  type TemplatePreviewResult,
  type TemplateSuggestion,
} from "./template-service";
