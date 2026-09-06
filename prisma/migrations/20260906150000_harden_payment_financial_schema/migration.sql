-- Finance integrity follow-up migration.
-- Keeps the live database schema aligned with prisma/schema.prisma and the
-- Stripe webhook/payment implementation.

-- Payment.branchId is nullable in the application because Stripe payments can
-- be created before branch context is recoverable from metadata. Preserve the
-- payment rather than rejecting it at the database layer.
ALTER TABLE "payments"
  ALTER COLUMN "branchId" DROP NOT NULL;

-- Stripe PaymentIntent IDs provide webhook idempotency. The unique index is
-- intentionally nullable so manual payments remain valid.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "stripePaymentIntentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripePaymentIntentId_key"
  ON "payments"("stripePaymentIntentId");

-- Failed Stripe PaymentIntents are financial events too and must be
-- representable in the same ledger as successful payments.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'FAILED';
