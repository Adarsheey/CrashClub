ALTER TABLE "Post" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'GENERAL';

ALTER TABLE "PostRecipient" ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "Post_category_status_publishedAt_idx" ON "Post"("category", "status", "publishedAt");
