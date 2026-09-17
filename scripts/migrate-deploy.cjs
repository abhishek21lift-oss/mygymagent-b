/**
 * Production boot gate: runs `prisma migrate deploy` before the app starts,
 * but refuses to hang silently the way a bare `prisma migrate deploy` does
 * in `npm run start`.
 *
 * Two failure modes this guards against (both observed on Render: 14+ min
 * of zero output, then a port-scan timeout kill):
 *
 * 1. Unreachable database (paused instance, rotated/wrong DATABASE_URL,
 *    firewall). A TCP pre-check fails this in seconds with an actionable
 *    message instead of an endless connect hang.
 * 2. A migration waiting on a table lock held by the still-live previous
 *    release (e.g. ADD CONSTRAINT against a written-to table). The overall
 *    timeout kills migrate and prints the lock-inspection query instead of
 *    burning the whole deploy window in silence.
 *
 * Success path is byte-identical to before: migrate applies, then the
 * caller (`&& node dist/main`) boots the app. Env knobs:
 *   MIGRATE_TCP_TIMEOUT_MS     (default 15000)  DB pre-check deadline
 *   MIGRATE_DEPLOY_TIMEOUT_MS  (default 600000) migrate hard deadline;
 *                              must stay below the platform's port-scan /
 *                              deploy timeout so OUR error lands first.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');

const TCP_TIMEOUT_MS = Number(process.env.MIGRATE_TCP_TIMEOUT_MS ?? 15000);
const DEPLOY_TIMEOUT_MS = Number(
  process.env.MIGRATE_DEPLOY_TIMEOUT_MS ?? 600000,
);

function redact(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable>';
  }
}

function dbTarget(url) {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`DATABASE_URL is not a postgres URL: ${redact(url)}`);
  }
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || 5432),
  };
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      '[migrate-deploy] FATAL: DATABASE_URL is not set. ' +
        'Set it in the deployment environment and redeploy.',
    );
    process.exit(1);
  }

  let target;
  try {
    target = dbTarget(databaseUrl);
  } catch (err) {
    console.error(`[migrate-deploy] FATAL: ${err.message}`);
    process.exit(1);
  }

  console.error(
    `[migrate-deploy] Probing ${target.host}:${target.port} ` +
      `(timeout ${TCP_TIMEOUT_MS}ms)...`,
  );
  const reachable = await checkTcp(target.host, target.port, TCP_TIMEOUT_MS);
  if (!reachable) {
    console.error(
      `[migrate-deploy] FATAL: cannot open a TCP connection to ` +
        `${target.host}:${target.port} for ${redact(databaseUrl)}. ` +
        'The database is unreachable (paused/suspended instance, wrong ' +
        'host, firewall, or exhausted connection proxies) -- `prisma ' +
        'migrate deploy` would hang here with no output. Fix connectivity ' +
        'and redeploy; no migrations were attempted.',
    );
    process.exit(1);
  }
  console.error('[migrate-deploy] Database reachable. Running migrations...');

  const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  const killTimer = setTimeout(() => {
    console.error(
      `[migrate-deploy] FATAL: migrations did not finish within ` +
        `${DEPLOY_TIMEOUT_MS}ms. Almost certainly a migration is waiting ` +
        `on a table lock held by the still-live previous release (migrate ` +
        `prints nothing while lock-waiting). Inspect with:\n` +
        `  SELECT pid, state, wait_event_type, wait_event, left(query, 120)\n` +
        `  FROM pg_stat_activity WHERE datname = current_database()\n` +
        `  ORDER BY query_start;\n` +
        `No app was started; the database is untouched apart from any ` +
        `migrations that already committed. Resolve the blocker and redeploy.`,
    );
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, DEPLOY_TIMEOUT_MS);
  killTimer.unref();

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      /* child already gone */
    }
  };
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));

  const code = await new Promise((resolve) => {
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    child.once('error', (err) => {
      console.error(`[migrate-deploy] FATAL: failed to launch prisma: ${err.message}`);
      resolve(1);
    });
  });
  clearTimeout(killTimer);

  if (code !== 0) {
    console.error(
      `[migrate-deploy] FATAL: \`prisma migrate deploy\` exited with code ` +
        `${code}. App will not start; fix the migration error above and redeploy.`,
    );
  } else {
    console.error('[migrate-deploy] Migrations applied. Handing off to the app.');
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(`[migrate-deploy] FATAL: ${err?.message ?? err}`);
  process.exit(1);
});
