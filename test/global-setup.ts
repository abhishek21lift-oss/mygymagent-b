import { execSync } from 'child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

/** Runs once before the e2e suite: applies migrations, seeds the RBAC
 * catalog against the test database, and ensures the local s3rver test
 * bucket exists (all against .env.test's config, loaded by the
 * `dotenv -e .env.test` wrapper in the `test:e2e` npm script). */
export default async function globalSetup(): Promise<void> {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
  await ensureTestBucket();
}

async function ensureTestBucket(): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  if (!endpoint || !bucket) return; // file-storage tests will be skipped/fail loudly, not silently

  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? 'auto',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
    forcePathStyle: true,
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    // BucketAlreadyOwnedByYou / BucketAlreadyExists -- fine, idempotent.
    // Anything else (e.g. s3rver not running) should fail loudly here
    // rather than surface as a confusing failure deep in a test.
    const code =
      (error as { Code?: string; name?: string }).Code ?? (error as Error).name;
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw error;
    }
  }
}
