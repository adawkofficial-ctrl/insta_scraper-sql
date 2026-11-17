-- Enforce the second cross-campaign key when the Instagram user id is known.
CREATE UNIQUE INDEX `LeadContactLedger_userId_instagramUserId_step_channel_key` ON `LeadContactLedger`(`userId`, `instagramUserId`, `step`, `channel`);
