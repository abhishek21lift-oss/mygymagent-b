-- Rendered message text for the inbox thread view. Nullable: rows written
-- before this column existed stay null and render a templateKey chip.
ALTER TABLE "message_logs" ADD COLUMN "body" TEXT;
