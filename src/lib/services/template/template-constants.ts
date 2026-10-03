// Client-safe template limits shared by the server service and the UI.
export const MAX_TEMPLATE_NAME_LENGTH = 100;

// Aligned with the messaging layer constraint (messaging-service MAX_MESSAGE_LENGTH).
export const MAX_TEMPLATE_BODY_LENGTH = 1000;

// Preview is draft-only; keep the batch small to avoid unnecessary load.
export const MAX_PREVIEW_LEADS = 10;
