-- Step 6: a draft-based BulkMessageItem may reference a draft at most once,
-- which makes "send approved" idempotent (double-click safe) at the DB level.
-- DropIndex
DROP INDEX "BulkMessageItem_draftId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "BulkMessageItem_draftId_key" ON "BulkMessageItem"("draftId");
