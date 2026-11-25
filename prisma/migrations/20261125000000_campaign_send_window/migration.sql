-- Campaign-level send timetable (days + local time window + timezone).
ALTER TABLE `Campaign`
  ADD COLUMN `sendWindowEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `sendWindowStart` VARCHAR(5) NULL,
  ADD COLUMN `sendWindowEnd` VARCHAR(5) NULL,
  ADD COLUMN `sendWindowDays` JSON NULL,
  ADD COLUMN `sendWindowTimezone` VARCHAR(64) NULL;
