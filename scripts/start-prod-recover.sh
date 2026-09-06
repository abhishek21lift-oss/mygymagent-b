#!/usr/bin/env bash
set -euo pipefail

# These migrations previously failed in production and must be explicitly
# rolled back before Prisma can retry them with the corrected SQL in main.
FAILED_MIGRATIONS=(
  "20260907000000_add_document_versioning"
  "20260907000000_add_member_intelligence_os"
)

for migration in "${FAILED_MIGRATIONS[@]}"; do
  printf '%s\n' "Checking production Prisma migration recovery: $migration"
  npx prisma migrate resolve --rolled-back "$migration" >/tmp/prisma-resolve.log 2>&1 || true
  cat /tmp/prisma-resolve.log

done

# Apply all pending migrations, including recovered migrations, before boot.
npx prisma migrate deploy
exec node dist/main
