ALTER TABLE "whatsapp_integrations"
  ADD COLUMN "waba_id" TEXT;

UPDATE "whatsapp_integrations"
SET "waba_id" = "business_account_id"
WHERE "waba_id" IS NULL
  AND "business_account_id" IS NOT NULL;

CREATE INDEX "whatsapp_integrations_waba_id_idx"
  ON "whatsapp_integrations"("waba_id");
