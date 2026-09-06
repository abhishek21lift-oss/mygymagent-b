-- Add stripePaymentIntentId column for Stripe integration
ALTER TABLE "payments" ADD COLUMN "stripePaymentIntentId" TEXT;
