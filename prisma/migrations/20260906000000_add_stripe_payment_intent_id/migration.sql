-- Add stripePaymentIntentId column for Stripe integration
ALTER TABLE "payments" ADD COLUMN "stripePaymentIntentId" TEXT;

-- Make it unique ( nullable unique constraint)
ALTER TABLE "payments" ADD CONSTRAINT "payments_stripePaymentIntentId_unique" UNIQUE ("stripePaymentIntentId");
