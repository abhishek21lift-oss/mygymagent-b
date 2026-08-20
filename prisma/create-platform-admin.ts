import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaClient, PlatformRole } from '@prisma/client';

/**
 * One-off, out-of-band way to create (or promote) a platform administrator.
 * Deliberately not reachable through any HTTP endpoint or the public
 * /auth/register flow -- platform-admin access must never be self-service.
 * Run manually against whichever database you're provisioning:
 *
 *   npx tsx prisma/create-platform-admin.ts \
 *     --email=you@example.com --password='...' \
 *     --firstName=Jane --lastName=Doe [--role=PLATFORM_OWNER|PLATFORM_ADMIN]
 *
 * If a user with that email already exists, this promotes them in place
 * (sets platformRole, does not touch organizationId or password unless
 * --password is given). Otherwise it creates a new platform-only user
 * (organizationId: null).
 */

function parseArgs(): {
  email: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  role: PlatformRole;
} {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }

  const email = args.get('email');
  if (!email) {
    throw new Error(
      'Usage: npx tsx prisma/create-platform-admin.ts --email=you@example.com --password=... --firstName=Jane --lastName=Doe [--role=PLATFORM_OWNER|PLATFORM_ADMIN]',
    );
  }

  const role = (args.get('role') ?? 'PLATFORM_OWNER') as PlatformRole;
  if (role !== 'PLATFORM_OWNER' && role !== 'PLATFORM_ADMIN') {
    throw new Error('--role must be PLATFORM_OWNER or PLATFORM_ADMIN');
  }

  return {
    email,
    password: args.get('password'),
    firstName: args.get('firstName'),
    lastName: args.get('lastName'),
    role,
  };
}

async function main() {
  const { email, password, firstName, lastName, role } = parseArgs();

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      const data: { platformRole: PlatformRole; passwordHash?: string } = {
        platformRole: role,
      };
      if (password) data.passwordHash = await argon2.hash(password);

      await prisma.user.update({ where: { id: existing.id }, data });
      console.log(
        `Promoted existing user ${email} to ${role}${password ? ' and reset their password' : ''}.`,
      );
      return;
    }

    if (!password || !firstName || !lastName) {
      throw new Error(
        `No user with email ${email} exists yet -- --password, --firstName, and --lastName are all required to create one.`,
      );
    }

    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.create({
      data: {
        organizationId: null,
        platformRole: role,
        email,
        passwordHash,
        firstName,
        lastName,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    console.log(`Created platform admin ${user.email} (${role}).`);
    console.log('Log in at POST /auth/login with the email/password you provided.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
