ALTER TABLE "Post" ADD COLUMN "eventId" UUID;

CREATE INDEX "Post_eventId_idx" ON "Post"("eventId");

ALTER TABLE "Post" ADD CONSTRAINT "Post_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
