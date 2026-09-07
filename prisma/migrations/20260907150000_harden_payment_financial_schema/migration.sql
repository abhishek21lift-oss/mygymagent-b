-- Finance integrity follow-up: align the payments table with the Prisma
-- schema the Stripe webhook/payment code actually writes against.

-- Payment.branchId is nullable in the application because a Stripe payment
-- can arrive (webhook) with no member/membership resolvable to a branch.
-- Preserve the payment rather than rejecting it at the database layer.
ALTER TABLE "payments"
  ALTER COLUMN "branchId" DROP NOT NULL;

-- Failed Stripe PaymentIntents are financial events too and must be
-- representable in the same ledger as successful payments.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- Stripe PaymentIntent IDs provide webhook redelivery idempotency. The
-- unique index is nullable so manual payments (no Stripe intent) remain
-- valid.
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripePaymentIntentId_key"
  ON "payments"("stripePaymentIntentId");
