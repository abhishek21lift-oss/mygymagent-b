import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { syncCatalogs } from '../src/catalog/catalog-sync';

const prisma = new PrismaClient();

/**
 * Idempotent: safe to run against a database that already has data.
 *
 * The work itself lives in `src/catalog/catalog-sync.ts`, because the
 * application now does the same thing at boot and two implementations
 * would drift -- which is the failure this whole change is about. This
 * script stays for local setup and for the e2e harness; production gets
 * it from the bootstrap hook, since deploy runs `prisma migrate deploy`
 * and nothing else.
 *
 * Organization-specific data (orgs, branches, staff, members) is created
 * through normal application flows (see AuthService.register), not here.
 */
async function main() {
  const report = await syncCatalogs(prisma);
  console.log('Catalog sync:', report);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
