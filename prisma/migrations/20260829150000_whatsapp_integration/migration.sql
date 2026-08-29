CREATE TABLE "whatsapp_integrations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "phone_number_id" TEXT NOT NULL,
  "business_account_id" TEXT,
  "display_phone_number" TEXT,
  "display_name" TEXT,
  "encrypted_access_token" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONNECTED',
  "last_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_integrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "whatsapp_integrations_organization_id_key" ON "whatsapp_integrations"("organization_id");
CREATE UNIQUE INDEX "whatsapp_integrations_phone_number_id_key" ON "whatsapp_integrations"("phone_number_id");
CREATE INDEX "whatsapp_integrations_status_idx" ON "whatsapp_integrations"("status");

CREATE TABLE "whatsapp_messages" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "phone_number_id" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "direction" TEXT NOT NULL,
  "from_number" TEXT,
  "to_number" TEXT,
  "message_type" TEXT NOT NULL DEFAULT 'text',
  "text" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "raw_payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "whatsapp_messages_provider_message_id_key" ON "whatsapp_messages"("provider_message_id");
CREATE INDEX "whatsapp_messages_org_created_idx" ON "whatsapp_messages"("organization_id", "created_at");
CREATE INDEX "whatsapp_messages_org_from_idx" ON "whatsapp_messages"("organization_id", "from_number");
CREATE INDEX "whatsapp_messages_org_to_idx" ON "whatsapp_messages"("organization_id", "to_number");
