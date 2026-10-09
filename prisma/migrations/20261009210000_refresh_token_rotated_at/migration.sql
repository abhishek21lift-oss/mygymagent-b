-- Marks refresh tokens revoked by rotation, so reuse detection fires only on
-- a replayed rotated token and not on one killed by logout or by an earlier
-- mass revocation. Nullable, no default => metadata-only column add.
-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "rotatedAt" TIMESTAMP(3);
