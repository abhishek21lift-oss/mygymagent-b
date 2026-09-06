#!/usr/bin/env bash
set -euo pipefail

MIGRATION="20260907000000_add_document_versioning"

# Prisma blocks all future migrations after a failed migration (P3009).
# Resolve only this known failed migration, and only when Prisma reports it.
STATUS="$(npx prisma migrate status 2>&1 || true)"
if printf '%s\n' "$STATUS" | grep -Fq "$MIGRATION"; then
  printf '%s\n' "Recovering failed Prisma migration: $MIGRATION"
  npx prisma migrate resolve --rolled-back "$MIGRATION"
fi

# Continue with the normal migration gate and application startup.
npx prisma migrate deploy
exec node dist/main
