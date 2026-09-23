#!/usr/bin/env node
/**
 * Fails when `prisma/migrations` and `prisma/schema.prisma` disagree.
 *
 * B-P0-12 closed 475 lines of accumulated drift. This is the part that
 * stops it coming back: the two can only diverge for as long as nobody
 * looks, and `migrate diff --exit-code` looks on every push.
 *
 * It compares the schema against a database *built from the migrations*,
 * in a throwaway shadow database -- so it catches the failure mode that
 * matters, a schema change committed without the migration that produces
 * it, which a check against the already-migrated dev database would miss.
 *
 * When this fails, the printed SQL is the difference. Resolve it one of
 * two ways, and the distinction is the whole lesson of B-P0-12:
 *   - the DATABASE is right and the model merely describes it badly (a
 *     constraint or index name, an `ON UPDATE`, a DB-side default) ->
 *     annotate the model (`map:`, `onUpdate:`, `dbgenerated(...)`). No
 *     DDL runs and nothing is at risk.
 *   - the SCHEMA is right and the database is genuinely missing something
 *     -> write a migration. Every such gap found in B-P0-12 was a live
 *     defect, not a cosmetic one.
 */
const { execFileSync } = require('node:child_process');

const shadow =
  process.env.SHADOW_DATABASE_URL ??
  process.env.DATABASE_URL;

if (!shadow) {
  console.error(
    'check-schema-drift: set DATABASE_URL (or SHADOW_DATABASE_URL) to a\n' +
      'database this check may create and drop objects in.',
  );
  process.exit(2);
}

try {
  execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadow,
      '--exit-code',
      '--script',
    ],
    { stdio: 'inherit' },
  );
  console.log('check-schema-drift: migrations and schema.prisma agree.');
} catch (error) {
  // `--exit-code` uses 2 for "there is a difference"; anything else is the
  // command itself failing, and the two should not be reported the same.
  if (error.status === 2) {
    console.error(
      '\ncheck-schema-drift: the SQL above is the difference between what\n' +
        'the migrations build and what schema.prisma describes. See the\n' +
        'header of this script for which side to change.',
    );
    process.exit(1);
  }
  console.error(`\ncheck-schema-drift: could not run the check (exit ${error.status}).`);
  process.exit(2);
}
