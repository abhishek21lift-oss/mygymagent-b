import { createHash } from 'crypto';

/**
 * The BullMQ key prefix for this deployment (B-P1-10).
 *
 * BullMQ's default prefix is the constant `bull`, so every process pointed
 * at the same Redis shares every queue -- and a worker takes whichever job
 * it reaches first, whatever deployment enqueued it. That is how the
 * low-stock alert "fired nothing at all": a dev API running beside the e2e
 * suite on the same Redis took the test's job, looked the organization up
 * in *its own* database, found no recipients, and completed it as a
 * success. In production the same thing happens between any two
 * environments that share a Redis (staging and production, a preview):
 * each silently processes the other's jobs against the wrong database.
 *
 * The prefix is therefore derived from the database this deployment uses.
 * Instances of one deployment share a database and so share queues, as
 * they must; anything with a different database never sees them. Only
 * host, port and database name go in -- not the user or password, so
 * rotating credentials does not move the queues -- and they are hashed,
 * so the connection details never appear in Redis key names.
 *
 * `QUEUE_PREFIX` overrides it, for a deployment that wants a readable name.
 */
export function queuePrefix(env: {
  QUEUE_PREFIX?: string;
  DATABASE_URL?: string;
}): string {
  const explicit = env.QUEUE_PREFIX?.trim();
  if (explicit) return explicit;

  const identity = databaseIdentity(env.DATABASE_URL ?? '');
  const digest = createHash('sha256').update(identity).digest('hex');
  return `bull-${digest.slice(0, 12)}`;
}

function databaseIdentity(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const port = url.port || '5432';
    const schema = url.searchParams.get('schema') ?? 'public';
    return `${url.hostname.toLowerCase()}:${port}${url.pathname}?schema=${schema}`;
  } catch {
    // Unparseable (or empty): still deterministic, still distinct from any
    // parseable URL's identity.
    return `raw:${databaseUrl}`;
  }
}
