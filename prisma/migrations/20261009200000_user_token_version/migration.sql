-- Session generation for access tokens: bumped on credential changes so
-- outstanding access tokens stop validating. Constant default => metadata-only
-- column add on Postgres 11+, no table rewrite.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
