import { execSync } from 'child_process';

/** Runs once before the e2e suite: applies migrations and seeds the RBAC
 * catalog against the test database (DATABASE_URL from .env.test, loaded
 * by the `dotenv -e .env.test` wrapper in the `test:e2e` npm script). */
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
}
