/**
 * Production boot gate: verify DB connectivity, then apply pending Prisma
 * migrations. Fails fast on any deploy error (including P3009 failed-
 * migration rows) with remediation instructions — no automatic migration
 * recovery runs in production. Operators resolve failed migrations
 * explicitly via `prisma migrate resolve` after verifying SQL safety.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');

const TCP_TIMEOUT_MS = Number(process.env.MIGRATE_TCP_TIMEOUT_MS ?? 15000);
const DEPLOY_TIMEOUT_MS = Number(process.env.MIGRATE_DEPLOY_TIMEOUT_MS ?? 600000);

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
  return { host: parsed.hostname || 'localhost', port: Number(parsed.port || 5432) };
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
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
    console.error('[migrate-deploy] FATAL: DATABASE_URL is not set.');
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
    `[migrate-deploy] Probing ${target.host}:${target.port} (timeout ${TCP_TIMEOUT_MS}ms)...`,
  );
  if (!await checkTcp(target.host, target.port, TCP_TIMEOUT_MS)) {
    console.error(
      `[migrate-deploy] FATAL: cannot open TCP connection to ${target.host}:${target.port} for ${redact(databaseUrl)}.`,
    );
    process.exit(1);
  }
  console.error('[migrate-deploy] Database reachable.');

  const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  const killTimer = setTimeout(() => {
    console.error(
      `[migrate-deploy] FATAL: migrations did not finish within ${DEPLOY_TIMEOUT_MS}ms.`,
    );
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, DEPLOY_TIMEOUT_MS);
  killTimer.unref();

  const forward = (signal) => {
    try { child.kill(signal); } catch {}
  };
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));

  const code = await new Promise((resolve) => {
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    child.once('error', (err) => {
      console.error(`[migrate-deploy] FATAL: failed to launch Prisma: ${err.message}`);
      resolve(1);
    });
  });
  clearTimeout(killTimer);

  if (code !== 0) {
    console.error(`[migrate-deploy] FATAL: prisma migrate deploy exited with code ${code}.`);
    console.error(
      '[migrate-deploy] If this is P3009 (failed migration row), inspect the failed migration SQL, verify it is safe to retry, then run explicitly:\n' +
        '  npx prisma migrate resolve --rolled-back <migration_name>\n' +
        '  npx prisma migrate deploy\n' +
        'Refusing to auto-recover failed migrations in production.',
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
