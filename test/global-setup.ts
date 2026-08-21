import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import type { SMTPServer } from 'smtp-server';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { startSmtpCaptureServer } from './utils/smtp-capture-server';

/** Runs once before the e2e suite: applies migrations, seeds the RBAC
 * catalog against the test database, ensures the local s3rver test
 * bucket exists, and starts the local SMTP capture server (all against
 * .env.test's config, loaded by the `dotenv -e .env.test` wrapper in the
 * `test:e2e` npm script). */
export default async function globalSetup(): Promise<void> {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
  await ensureTestBucket();

  // Jest keeps this orchestrator process alive for the whole run and
  // calls global-teardown.ts from it too, so a plain global (the same
  // pattern Jest's own docs use for an in-memory Mongo instance) is
  // enough to hand the server reference across -- no subprocess/pid
  // bookkeeping, and test-file workers reach it over a real TCP
  // connection like they would any other local service.
  const captureFile =
    process.env.SMTP_TEST_CAPTURE_FILE ?? 'test/.runtime/smtp-capture.jsonl';
  if (existsSync(captureFile)) rmSync(captureFile);
  const server = await startSmtpCaptureServer(
    Number(process.env.SMTP_TEST_PORT ?? '2525'),
    captureFile,
  );
  (
    globalThis as typeof globalThis & { __SMTP_CAPTURE_SERVER__?: SMTPServer }
  ).__SMTP_CAPTURE_SERVER__ = server;
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
