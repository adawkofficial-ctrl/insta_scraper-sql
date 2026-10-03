ALTER TABLE "Message" ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "contentHash" TEXT;

CREATE INDEX "Message_idempotencyKey_idx" ON "Message"("idempotencyKey");
CREATE INDEX "Message_contentHash_idx" ON "Message"("contentHash");