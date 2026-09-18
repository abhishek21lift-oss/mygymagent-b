/**
 * Production boot gate: verify DB connectivity, recover the currently known
 * failed migration, then apply all pending Prisma migrations.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');

const TCP_TIMEOUT_MS = Number(process.env.MIGRATE_TCP_TIMEOUT_MS ?? 15000);
const DEPLOY_TIMEOUT_MS = Number(process.env.MIGRATE_DEPLOY_TIMEOUT_MS ?? 600000);
const FAILED_MIGRATION = process.env.FAILED_MIGRATION ??
  '20260916100000_add_member_intelligence_os';

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

function runPrisma(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['prisma', ...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: process.env,
    });
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', (err) => {
      console.error(`[migrate-deploy] FATAL: failed to launch prisma: ${err.message}`);
      resolve(1);
    });
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

  // Render was blocked on this migration with P3009. The migration is
  // transactional, so a failed run leaves no partial schema changes.
  console.error(`[migrate-deploy] Recovering failed migration: ${FAILED_MIGRATION}`);
  const resolveCode = await runPrisma([
    'migrate',
    'resolve',
    '--rolled-back',
    FAILED_MIGRATION,
  ]);
  if (resolveCode !== 0) {
    // Idempotent boot: Prisma returns non-zero when the migration is already
    // resolved/applied. In that case migrate deploy below is authoritative.
    console.error(
      '[migrate-deploy] WARN: rollback resolution was not needed or was already resolved; continuing to migrate deploy.',
    );
  }

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
      console.error(`[migrate-deploy] FATAL: ${err.message}`);
      resolve(1);
    });
  });
  clearTimeout(killTimer);

  if (code !== 0) {
    console.error(`[migrate-deploy] FATAL: prisma migrate deploy exited with code ${code}.`);
  } else {
    console.error('[migrate-deploy] Migrations applied. Handing off to the app.');
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(`[migrate-deploy] FATAL: ${err?.message ?? err}`);
  process.exit(1);
});
