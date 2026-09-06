#!/usr/bin/env bash
set -euo pipefail

MIGRATION="20260907000000_add_document_versioning"

# Prisma blocks all future migrations after a failed migration (P3009).
# This migration is intentionally idempotent, so recover the known failed
# migration first; if it is already applied (or does not exist in the target
# database), Prisma will reject resolve and we safely continue to deploy.
printf '%s\n' "Checking production Prisma migration recovery: $MIGRATION"
npx prisma migrate resolve --rolled-back "$MIGRATION" >/tmp/prisma-resolve.log 2>&1 || true
cat /tmp/prisma-resolve.log

# Apply all pending migrations, including the recovered migration, before boot.
npx prisma migrate deploy
exec node dist/main
