-- Stable per-account stagger for existing senders (new accounts get sequential offsets in code).
UPDATE `InstagramSenderAccount` SET `scheduleOffsetSeconds` = (CRC32(`id`) % 60) * 61 WHERE `scheduleOffsetSeconds` = 0;
