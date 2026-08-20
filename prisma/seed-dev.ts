import 'dotenv/config';
import { execSync } from 'child_process';
import * as argon2 from 'argon2';
import { PrismaClient, MembershipStatus, AttendanceMethod } from '@prisma/client';

/**
 * Safe DEVELOPMENT-ONLY demo data: one demo organization, branches, staff
 * across every role, trainers, members, membership plans, memberships, and
 * attendance history. Never run against production -- refuses to run
 * unless NODE_ENV is unset or "development".
 *
 * Exercises, products, and sample financial transactions from the original
 * spec are NOT seeded here: Exercise/Product/Payment tables don't exist yet
 * (workouts, inventory, and billing are still module skeletons -- see
 * docs/ARCHITECTURE.md). Seed those once their schemas land.
 */

const DEMO_PASSWORD = 'DemoPass123!';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run dev seed data with NODE_ENV=production.');
  }

  // Ensure the RBAC catalog (permissions + system roles) exists first --
  // this script only adds organization-scoped demo data on top of it.
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });

  const prisma = new PrismaClient();

  try {
    const existing = await prisma.organization.findUnique({
      where: { slug: 'demo-fitness-club' },
    });
    if (existing) {
      console.log('Demo organization already seeded, skipping.');
      return;
    }

    const passwordHash = await argon2.hash(DEMO_PASSWORD);

    const roleKeys = [
      'ORG_OWNER',
      'ORG_ADMIN',
      'BRANCH_MANAGER',
      'HEAD_TRAINER',
      'TRAINER',
      'RECEPTIONIST',
      'SALES_EXECUTIVE',
      'ACCOUNTANT',
    ] as const;
    const roles = await prisma.role.findMany({
      where: { organizationId: null, key: { in: [...roleKeys] } },
    });
    const roleByKey = new Map(roles.map((r) => [r.key, r]));
    const requireRole = (key: (typeof roleKeys)[number]) => {
      const role = roleByKey.get(key);
      if (!role) throw new Error(`System role ${key} not found -- run "npm run db:seed" first.`);
      return role;
    };

    console.log('Creating demo organization...');
    const org = await prisma.organization.create({
      data: {
        name: 'Demo Fitness Club',
        slug: 'demo-fitness-club',
        status: 'ACTIVE',
        timezone: 'America/New_York',
        currency: 'USD',
      },
    });

    const [downtown, uptown] = await Promise.all([
      prisma.branch.create({
        data: {
          organizationId: org.id,
          name: 'Downtown',
          slug: 'downtown',
          status: 'ACTIVE',
          city: 'New York',
          state: 'NY',
          country: 'US',
        },
      }),
      prisma.branch.create({
        data: {
          organizationId: org.id,
          name: 'Uptown',
          slug: 'uptown',
          status: 'ACTIVE',
          city: 'New York',
          state: 'NY',
          country: 'US',
        },
      }),
    ]);

    console.log('Creating demo staff (one per role)...');
    const staffDefs = [
      { email: 'owner@demogym.test', firstName: 'Olivia', lastName: 'Owner', role: 'ORG_OWNER', branch: null },
      { email: 'admin@demogym.test', firstName: 'Aiden', lastName: 'Admin', role: 'ORG_ADMIN', branch: null },
      { email: 'manager@demogym.test', firstName: 'Maya', lastName: 'Manager', role: 'BRANCH_MANAGER', branch: downtown },
      { email: 'headtrainer@demogym.test', firstName: 'Hank', lastName: 'Head', role: 'HEAD_TRAINER', branch: downtown, isTrainer: true },
      { email: 'trainer1@demogym.test', firstName: 'Tara', lastName: 'Trainer', role: 'TRAINER', branch: downtown, isTrainer: true },
      { email: 'trainer2@demogym.test', firstName: 'Theo', lastName: 'Trainer', role: 'TRAINER', branch: uptown, isTrainer: true },
      { email: 'reception@demogym.test', firstName: 'Rita', lastName: 'Reception', role: 'RECEPTIONIST', branch: downtown },
      { email: 'sales@demogym.test', firstName: 'Sam', lastName: 'Sales', role: 'SALES_EXECUTIVE', branch: uptown },
      { email: 'accountant@demogym.test', firstName: 'Ana', lastName: 'Accountant', role: 'ACCOUNTANT', branch: null },
    ] as const;

    const staffUsers = new Map<string, { id: string }>();
    for (const def of staffDefs) {
      const user = await prisma.user.create({
        data: {
          organizationId: org.id,
          email: def.email,
          passwordHash,
          firstName: def.firstName,
          lastName: def.lastName,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          primaryBranchId: def.branch?.id,
        },
      });
      staffUsers.set(def.email, user);

      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: requireRole(def.role).id,
          organizationId: org.id,
          branchId: def.branch?.id,
        },
      });

      if (def.branch) {
        await prisma.staffProfile.create({
          data: {
            userId: user.id,
            organizationId: org.id,
            branchId: def.branch.id,
            jobTitle: def.role.replace('_', ' '),
            isTrainer: 'isTrainer' in def ? Boolean(def.isTrainer) : false,
          },
        });
      }
    }
    const trainer1 = staffUsers.get('trainer1@demogym.test')!;
    const trainer2 = staffUsers.get('trainer2@demogym.test')!;
    const receptionist = staffUsers.get('reception@demogym.test')!;

    console.log('Creating membership plans...');
    const plans = await Promise.all([
      prisma.membershipPlan.create({
        data: {
          organizationId: org.id,
          name: 'Monthly Basic',
          description: 'Full gym access, month to month.',
          durationDays: 30,
          price: 49.99,
          benefits: ['Gym floor access', 'Locker room'],
          maxFreezeDays: 7,
        },
      }),
      prisma.membershipPlan.create({
        data: {
          organizationId: org.id,
          name: 'Quarterly Pro',
          description: '3-month plan with group classes included.',
          durationDays: 90,
          price: 129.99,
          benefits: ['Gym floor access', 'Group classes', 'Locker room'],
          maxFreezeDays: 14,
        },
      }),
      prisma.membershipPlan.create({
        data: {
          organizationId: org.id,
          name: 'Annual Elite',
          description: 'Best value: 12 months, includes 2 PT sessions/month.',
          durationDays: 365,
          price: 499.99,
          benefits: ['Gym floor access', 'Group classes', '2 PT sessions/month', 'Locker room'],
          maxFreezeDays: 30,
        },
      }),
    ]);

    console.log('Creating demo members with memberships and attendance...');
    const firstNames = ['Alex', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noor', 'OKane'];
    const lastNames = ['Adams', 'Brooks', 'Chen', 'Diaz', 'Evans', 'Foster', 'Garcia', 'Hughes', 'Ito', 'Jones', 'Khan', 'Lopez', 'Moore', 'Nash', 'Ortiz'];

    for (let i = 0; i < firstNames.length; i++) {
      const branch = i % 2 === 0 ? downtown : uptown;
      const trainer = i % 3 === 0 ? (branch === downtown ? trainer1 : trainer2) : null;
      const plan = plans[i % plans.length];

      const member = await prisma.member.create({
        data: {
          organizationId: org.id,
          primaryBranchId: branch.id,
          memberCode: `DEMO-${String(i + 1).padStart(4, '0')}`,
          firstName: firstNames[i],
          lastName: lastNames[i],
          email: `${firstNames[i].toLowerCase()}.${lastNames[i].toLowerCase()}@example.test`,
          phone: `+1555010${String(i).padStart(4, '0')}`,
          gender: i % 2 === 0 ? 'MALE' : 'FEMALE',
          status: i === firstNames.length - 1 ? 'INACTIVE' : 'ACTIVE',
          assignedTrainerId: trainer?.id,
          joinedAt: new Date(Date.now() - (30 + i) * 24 * 60 * 60 * 1000),
        },
      });

      const startDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const endDate = new Date(startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
      await prisma.membership.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          memberId: member.id,
          membershipPlanId: plan.id,
          status: MembershipStatus.ACTIVE,
          startDate,
          endDate,
          price: plan.price,
        },
      });

      const visits = 3 + (i % 5);
      for (let v = 0; v < visits; v++) {
        const checkInAt = new Date(Date.now() - v * 2 * 24 * 60 * 60 * 1000);
        await prisma.attendance.create({
          data: {
            organizationId: org.id,
            branchId: branch.id,
            memberId: member.id,
            checkInAt,
            checkOutAt: new Date(checkInAt.getTime() + 60 * 60 * 1000),
            method: v % 2 === 0 ? AttendanceMethod.QR : AttendanceMethod.MANUAL,
            recordedByUserId: receptionist.id,
          },
        });
      }
    }

    console.log('\nDemo seed complete.');
    console.log(`Organization: Demo Fitness Club (${org.slug})`);
    console.log(`Branches: Downtown, Uptown`);
    console.log(`Members: ${firstNames.length}`);
    console.log('\nLogin with any of these (all share the same password):');
    for (const def of staffDefs) console.log(`  ${def.email}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
