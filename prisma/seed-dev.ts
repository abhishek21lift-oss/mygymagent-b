import 'dotenv/config';
import { execSync } from 'child_process';
import * as argon2 from 'argon2';
import type { Prisma } from '@prisma/client';
import {
  AttendanceMethod,
  DietAssignmentStatus,
  LeadStatus,
  MembershipStatus,
  PaymentMethod,
  PrismaClient,
  PtSessionStatus,
  PtSessionType,
  StockMovementType,
  WorkoutAssignmentStatus,
} from '@prisma/client';

/**
 * Safe DEVELOPMENT-ONLY demo data: one demo organization, branches, staff
 * across every role, trainers, members, membership plans, memberships,
 * attendance history, the workout engine (exercises, plans, assignments,
 * session execution), nutrition, inventory, CRM leads, gym payments/
 * refunds, booked PT sessions, and Member 360 (notes, goals, consents).
 * Every screen and AI tool in the web app has real data on first login.
 * Never run against production -- refuses to run unless NODE_ENV is unset
 * or "development".
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
      if (!role)
        throw new Error(
          `System role ${key} not found -- run "npm run db:seed" first.`,
        );
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
      {
        email: 'owner@demogym.test',
        firstName: 'Olivia',
        lastName: 'Owner',
        role: 'ORG_OWNER',
        branch: null,
      },
      {
        email: 'admin@demogym.test',
        firstName: 'Aiden',
        lastName: 'Admin',
        role: 'ORG_ADMIN',
        branch: null,
      },
      {
        email: 'manager@demogym.test',
        firstName: 'Maya',
        lastName: 'Manager',
        role: 'BRANCH_MANAGER',
        branch: downtown,
      },
      {
        email: 'headtrainer@demogym.test',
        firstName: 'Hank',
        lastName: 'Head',
        role: 'HEAD_TRAINER',
        branch: downtown,
        isTrainer: true,
      },
      {
        email: 'trainer1@demogym.test',
        firstName: 'Tara',
        lastName: 'Trainer',
        role: 'TRAINER',
        branch: downtown,
        isTrainer: true,
      },
      {
        email: 'trainer2@demogym.test',
        firstName: 'Theo',
        lastName: 'Trainer',
        role: 'TRAINER',
        branch: uptown,
        isTrainer: true,
      },
      {
        email: 'reception@demogym.test',
        firstName: 'Rita',
        lastName: 'Reception',
        role: 'RECEPTIONIST',
        branch: downtown,
      },
      {
        email: 'sales@demogym.test',
        firstName: 'Sam',
        lastName: 'Sales',
        role: 'SALES_EXECUTIVE',
        branch: uptown,
      },
      {
        email: 'accountant@demogym.test',
        firstName: 'Ana',
        lastName: 'Accountant',
        role: 'ACCOUNTANT',
        branch: null,
      },
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
          benefits: [
            'Gym floor access',
            'Group classes',
            '2 PT sessions/month',
            'Locker room',
          ],
          maxFreezeDays: 30,
        },
      }),
    ]);

    console.log('Creating demo members with memberships and attendance...');
    const firstNames = [
      'Alex',
      'Blake',
      'Casey',
      'Drew',
      'Emery',
      'Finley',
      'Gray',
      'Harper',
      'Indigo',
      'Jules',
      'Kai',
      'Lane',
      'Morgan',
      'Noor',
      'OKane',
    ];
    const lastNames = [
      'Adams',
      'Brooks',
      'Chen',
      'Diaz',
      'Evans',
      'Foster',
      'Garcia',
      'Hughes',
      'Ito',
      'Jones',
      'Khan',
      'Lopez',
      'Moore',
      'Nash',
      'Ortiz',
    ];

    const members: { id: string; primaryBranchId: string }[] = [];
    const memberships: {
      id: string;
      memberId: string;
      branchId: string;
      price: number;
    }[] = [];

    for (let i = 0; i < firstNames.length; i++) {
      const branch = i % 2 === 0 ? downtown : uptown;
      const trainer =
        i % 3 === 0 ? (branch === downtown ? trainer1 : trainer2) : null;
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
      members.push({ id: member.id, primaryBranchId: branch.id });

      const startDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const endDate = new Date(
        startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000,
      );
      const membership = await prisma.membership.create({
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
      memberships.push({
        id: membership.id,
        memberId: member.id,
        branchId: branch.id,
        price: Number(membership.price),
      });

      // The last two members are deliberately at-risk: their only visits
      // happened 20+ days ago, so the at-risk analytics and the dashboard
      // watch list light up on first login.
      const atRisk = i === 12 || i === 13;
      const visits = 3 + (i % 5);
      for (let v = 0; v < visits; v++) {
        const offsetDays = atRisk ? 20 + v * 2 : v * 2;
        const checkInAt = new Date(
          Date.now() - offsetDays * 24 * 60 * 60 * 1000,
        );
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

    const headTrainer = staffUsers.get('headtrainer@demogym.test')!;
    const salesUser = staffUsers.get('sales@demogym.test')!;
    const accountant = staffUsers.get('accountant@demogym.test')!;

    // ------------------------------------------------------------------
    // Workout engine: exercise library, plans, assignments, execution
    // ------------------------------------------------------------------
    console.log('Creating workout library, plans and assignments...');
    const exerciseDefs = [
      { name: 'Barbell Back Squat', muscleGroup: 'Legs', equipment: 'Barbell' },
      { name: 'Bench Press', muscleGroup: 'Chest', equipment: 'Barbell' },
      { name: 'Deadlift', muscleGroup: 'Back', equipment: 'Barbell' },
      { name: 'Pull-Up', muscleGroup: 'Back', equipment: 'Bodyweight' },
      {
        name: 'Overhead Press',
        muscleGroup: 'Shoulders',
        equipment: 'Barbell',
      },
      { name: 'Plank', muscleGroup: 'Core', equipment: 'Bodyweight' },
      { name: 'Leg Press', muscleGroup: 'Legs', equipment: 'Machine' },
      { name: 'Lat Pulldown', muscleGroup: 'Back', equipment: 'Machine' },
      { name: 'Treadmill Run', muscleGroup: 'Cardio', equipment: 'Treadmill' },
      {
        name: 'Romanian Deadlift',
        muscleGroup: 'Hamstrings',
        equipment: 'Barbell',
      },
    ];
    const exerciseMap = new Map<string, { id: string }>();
    for (const def of exerciseDefs) {
      const exercise = await prisma.exercise.create({
        data: { organizationId: org.id, ...def },
      });
      exerciseMap.set(def.name, exercise);
    }
    const ex = (name: string) => ({ exerciseId: exerciseMap.get(name)!.id });
    const exerciseEntry = (
      name: string,
      order: number,
      sets: number,
      reps: string,
      restSeconds?: number,
    ) => ({
      ...ex(name),
      order,
      sets,
      reps,
      ...(restSeconds !== undefined ? { restSeconds } : {}),
    });

    const workoutPlans = await Promise.all([
      prisma.workoutPlan.create({
        data: {
          organizationId: org.id,
          name: 'Full Body Foundation',
          description: '3-day full body program for new members.',
          createdByUserId: headTrainer.id,
          exercises: [
            exerciseEntry('Barbell Back Squat', 1, 3, '8-12', 90),
            exerciseEntry('Bench Press', 2, 3, '8-12', 90),
            exerciseEntry('Lat Pulldown', 3, 3, '10-12', 60),
            exerciseEntry('Plank', 4, 3, '30-45s', 45),
            exerciseEntry('Treadmill Run', 5, 1, '15 min', 0),
          ],
        },
      }),
      prisma.workoutPlan.create({
        data: {
          organizationId: org.id,
          name: 'Upper/Lower Strength',
          description: 'Intermediate 4-day split for strength progression.',
          createdByUserId: headTrainer.id,
          exercises: [
            exerciseEntry('Barbell Back Squat', 1, 5, '5', 120),
            exerciseEntry('Bench Press', 2, 5, '5', 120),
            exerciseEntry('Romanian Deadlift', 3, 3, '8', 90),
            exerciseEntry('Pull-Up', 4, 4, '6-10', 90),
            exerciseEntry('Overhead Press', 5, 3, '8-10', 90),
          ],
        },
      }),
      prisma.workoutPlan.create({
        data: {
          organizationId: org.id,
          name: 'Cardio Conditioning',
          description: 'Heart-rate zone training for endurance.',
          createdByUserId: headTrainer.id,
          exercises: [exerciseEntry('Treadmill Run', 1, 1, '30 min', 0)],
        },
      }),
    ]);

    const assignments: {
      id: string;
      memberId: string;
      workoutPlanId: string;
    }[] = [];
    for (const [index, member] of members.slice(0, 5).entries()) {
      const assignment = await prisma.workoutAssignment.create({
        data: {
          organizationId: org.id,
          workoutPlanId: workoutPlans[index % workoutPlans.length].id,
          memberId: member.id,
          assignedByUserId: headTrainer.id,
          status: WorkoutAssignmentStatus.ACTIVE,
          startDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
          notes: 'Follow the programmed sets; log every set in the app.',
        },
      });
      assignments.push({
        id: assignment.id,
        memberId: member.id,
        workoutPlanId: assignment.workoutPlanId,
      });
    }

    // Workout execution: one completed session yesterday, one in-progress today
    const snapshotFor = (plan: { id: string }): Prisma.InputJsonValue => {
      const planRow = workoutPlans.find((p) => p.id === plan.id)!;
      const exercises = planRow.exercises as Array<{
        exerciseId?: unknown;
        sets?: unknown;
        reps?: unknown;
        restSeconds?: unknown;
      }>;
      return exercises.map((entry, i) => ({
        id: `demo-snap-${plan.id.slice(0, 8)}-${i + 1}`,
        exerciseId:
          typeof entry.exerciseId === 'string' ? entry.exerciseId : null,
        name:
          exerciseDefs.find(
            (d) => exerciseMap.get(d.name)!.id === entry.exerciseId,
          )?.name ?? 'Exercise',
        setsTarget: typeof entry.sets === 'number' ? entry.sets : null,
        repsTarget: typeof entry.reps === 'string' ? entry.reps : '—',
        restSeconds:
          typeof entry.restSeconds === 'number' ? entry.restSeconds : null,
        displayOrder: i + 1,
        notes: null,
      }));
    };

    const completedAssignment = assignments[0];
    const completedPlan = workoutPlans.find(
      (p) => p.id === completedAssignment.workoutPlanId,
    )!;
    const completedSnapshot = snapshotFor(completedPlan);
    const completedSession = await prisma.workoutSession.create({
      data: {
        organizationId: org.id,
        assignmentId: completedAssignment.id,
        memberId: completedAssignment.memberId,
        branchId: members[0].primaryBranchId,
        sessionDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        status: 'COMPLETED',
        startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        completedAt: new Date(
          Date.now() - 24 * 60 * 60 * 1000 + 50 * 60 * 1000,
        ),
        exercises: completedSnapshot,
        createdByUserId: headTrainer.id,
      },
    });
    for (let setNumber = 1; setNumber <= 2; setNumber++) {
      await prisma.workoutSessionSet.create({
        data: {
          organizationId: org.id,
          sessionId: completedSession.id,
          exerciseId: completedSnapshot[0].id,
          setNumber,
          weightKg: 60 + setNumber * 5,
          reps: 10,
          rpe: 7 + setNumber * 0.5,
          completedAt: new Date(
            Date.now() - 24 * 60 * 60 * 1000 + setNumber * 10 * 60 * 1000,
          ),
        },
      });
    }

    const activeAssignment = assignments[1];
    const activePlan = workoutPlans.find(
      (p) => p.id === activeAssignment.workoutPlanId,
    )!;
    const activeSnapshot = snapshotFor(activePlan);
    const activeSession = await prisma.workoutSession.create({
      data: {
        organizationId: org.id,
        assignmentId: activeAssignment.id,
        memberId: activeAssignment.memberId,
        branchId: members[1].primaryBranchId,
        status: 'IN_PROGRESS',
        exercises: activeSnapshot,
        createdByUserId: headTrainer.id,
      },
    });
    await prisma.workoutSessionSet.create({
      data: {
        organizationId: org.id,
        sessionId: activeSession.id,
        exerciseId: activeSnapshot[0].id,
        setNumber: 1,
        weightKg: 50,
        reps: 12,
        rpe: 6,
      },
    });

    // ------------------------------------------------------------------
    // Nutrition: food library, diet plans, assignments
    // ------------------------------------------------------------------
    console.log('Creating nutrition library, diet plans and assignments...');
    const foodDefs = [
      {
        name: 'Chicken Breast',
        servingSize: '100g',
        calories: 165,
        proteinG: 31,
        carbsG: 0,
        fatG: 3.6,
      },
      {
        name: 'Brown Rice',
        servingSize: '1 cup',
        calories: 216,
        proteinG: 5,
        carbsG: 45,
        fatG: 1.8,
      },
      {
        name: 'Rolled Oats',
        servingSize: '50g',
        calories: 194,
        proteinG: 7,
        carbsG: 33,
        fatG: 3.4,
      },
      {
        name: 'Whole Eggs',
        servingSize: '1 egg',
        calories: 72,
        proteinG: 6.3,
        carbsG: 0.4,
        fatG: 4.8,
      },
      {
        name: 'Whey Protein',
        servingSize: '1 scoop',
        calories: 120,
        proteinG: 24,
        carbsG: 3,
        fatG: 1,
      },
      {
        name: 'Sweet Potato',
        servingSize: '150g',
        calories: 129,
        proteinG: 2.4,
        carbsG: 30,
        fatG: 0.2,
      },
      {
        name: 'Almonds',
        servingSize: '28g',
        calories: 164,
        proteinG: 6,
        carbsG: 6,
        fatG: 14,
      },
      {
        name: 'Broccoli',
        servingSize: '100g',
        calories: 34,
        proteinG: 2.8,
        carbsG: 7,
        fatG: 0.4,
      },
    ];
    const foodMap = new Map<string, { id: string }>();
    for (const def of foodDefs) {
      const item = await prisma.foodItem.create({
        data: { organizationId: org.id, ...def },
      });
      foodMap.set(def.name, item);
    }

    const dietPlans = await Promise.all([
      prisma.dietPlan.create({
        data: {
          organizationId: org.id,
          name: 'Balanced Fat Loss',
          description: '~2000 kcal with high protein for a moderate deficit.',
          createdByUserId: headTrainer.id,
          targetCalories: 2000,
          targetProteinG: 150,
          targetCarbsG: 180,
          targetFatG: 60,
          items: [
            {
              foodItemId: foodMap.get('Rolled Oats')!.id,
              mealSlot: 'BREAKFAST',
              quantity: 1,
              unit: '50g',
            },
            {
              foodItemId: foodMap.get('Whole Eggs')!.id,
              mealSlot: 'BREAKFAST',
              quantity: 3,
              unit: 'eggs',
            },
            {
              foodItemId: foodMap.get('Chicken Breast')!.id,
              mealSlot: 'LUNCH',
              quantity: 1,
              unit: '150g',
            },
            {
              foodItemId: foodMap.get('Brown Rice')!.id,
              mealSlot: 'LUNCH',
              quantity: 1,
              unit: 'cup',
            },
            {
              foodItemId: foodMap.get('Broccoli')!.id,
              mealSlot: 'LUNCH',
              quantity: 1,
              unit: '100g',
            },
            {
              foodItemId: foodMap.get('Whey Protein')!.id,
              mealSlot: 'SNACK',
              quantity: 1,
              unit: 'scoop',
            },
            {
              foodItemId: foodMap.get('Sweet Potato')!.id,
              mealSlot: 'DINNER',
              quantity: 1,
              unit: '150g',
            },
            {
              foodItemId: foodMap.get('Almonds')!.id,
              mealSlot: 'SNACK',
              quantity: 1,
              unit: '28g',
            },
          ],
        },
      }),
      prisma.dietPlan.create({
        data: {
          organizationId: org.id,
          name: 'High Protein Lean Bulk',
          description: '~2800 kcal for muscle gain with clean sources.',
          createdByUserId: headTrainer.id,
          targetCalories: 2800,
          targetProteinG: 180,
          targetCarbsG: 320,
          targetFatG: 80,
          items: [
            {
              foodItemId: foodMap.get('Rolled Oats')!.id,
              mealSlot: 'BREAKFAST',
              quantity: 2,
              unit: '50g',
            },
            {
              foodItemId: foodMap.get('Whole Eggs')!.id,
              mealSlot: 'BREAKFAST',
              quantity: 4,
              unit: 'eggs',
            },
            {
              foodItemId: foodMap.get('Chicken Breast')!.id,
              mealSlot: 'LUNCH',
              quantity: 2,
              unit: '150g',
            },
            {
              foodItemId: foodMap.get('Brown Rice')!.id,
              mealSlot: 'LUNCH',
              quantity: 2,
              unit: 'cups',
            },
            {
              foodItemId: foodMap.get('Whey Protein')!.id,
              mealSlot: 'SNACK',
              quantity: 2,
              unit: 'scoops',
            },
            {
              foodItemId: foodMap.get('Sweet Potato')!.id,
              mealSlot: 'DINNER',
              quantity: 1,
              unit: '200g',
            },
            {
              foodItemId: foodMap.get('Almonds')!.id,
              mealSlot: 'SNACK',
              quantity: 1,
              unit: '28g',
            },
          ],
        },
      }),
    ]);

    for (const [index, member] of [members[1], members[3]].entries()) {
      await prisma.dietAssignment.create({
        data: {
          organizationId: org.id,
          dietPlanId: dietPlans[index].id,
          memberId: member.id,
          assignedByUserId: headTrainer.id,
          status: DietAssignmentStatus.ACTIVE,
          startDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          notes: 'Log meals against the plan targets weekly.',
        },
      });
    }

    // ------------------------------------------------------------------
    // Inventory: products + stock ledger (one product below reorder level
    // so the low-stock alert and forecast analytics have real data)
    // ------------------------------------------------------------------
    console.log('Creating inventory...');
    const productDefs: Array<{
      sku: string;
      name: string;
      description: string;
      category: string;
      unitPrice: number;
      costPrice: number;
      quantityOnHand: number;
      reorderLevel: number;
      movements: Array<{
        type: StockMovementType;
        quantity: number;
        note: string;
      }>;
    }> = [
      {
        sku: 'SUP-001',
        name: 'Whey Protein 2kg',
        description: 'Chocolate flavor isolate blend',
        category: 'Supplements',
        unitPrice: 59.99,
        costPrice: 42,
        quantityOnHand: 12,
        reorderLevel: 5,
        movements: [
          {
            type: StockMovementType.RESTOCK,
            quantity: 25,
            note: 'Initial stock',
          },
          { type: StockMovementType.SALE, quantity: -10, note: 'Retail sale' },
          { type: StockMovementType.SALE, quantity: -3, note: 'Retail sale' },
        ],
      },
      {
        sku: 'SUP-002',
        name: 'Pre-Workout 30 servings',
        description: 'Caffeine + beta-alanine formula',
        category: 'Supplements',
        unitPrice: 34.99,
        costPrice: 22,
        quantityOnHand: 4,
        reorderLevel: 10,
        movements: [
          {
            type: StockMovementType.RESTOCK,
            quantity: 20,
            note: 'Initial stock',
          },
          { type: StockMovementType.SALE, quantity: -16, note: 'Retail sales' },
        ],
      },
      {
        sku: 'SUP-003',
        name: 'Creatine Monohydrate',
        description: '300g micronized creatine',
        category: 'Supplements',
        unitPrice: 24.99,
        costPrice: 15,
        quantityOnHand: 9,
        reorderLevel: 5,
        movements: [
          {
            type: StockMovementType.RESTOCK,
            quantity: 15,
            note: 'Initial stock',
          },
          { type: StockMovementType.SALE, quantity: -6, note: 'Retail sales' },
        ],
      },
      {
        sku: 'EQ-001',
        name: 'Resistance Bands Set',
        description: '5-level loop bands',
        category: 'Equipment',
        unitPrice: 29.99,
        costPrice: 18,
        quantityOnHand: 30,
        reorderLevel: 8,
        movements: [
          {
            type: StockMovementType.RESTOCK,
            quantity: 30,
            note: 'Initial stock',
          },
        ],
      },
      {
        sku: 'ACC-001',
        name: 'Shaker Bottle 700ml',
        description: 'Leak-proof mixing bottle',
        category: 'Accessories',
        unitPrice: 12.99,
        costPrice: 6,
        quantityOnHand: 18,
        reorderLevel: 6,
        movements: [
          {
            type: StockMovementType.RESTOCK,
            quantity: 20,
            note: 'Initial stock',
          },
          { type: StockMovementType.SALE, quantity: -2, note: 'Retail sale' },
        ],
      },
    ];
    for (const def of productDefs) {
      const product = await prisma.product.create({
        data: {
          organizationId: org.id,
          sku: def.sku,
          name: def.name,
          description: def.description,
          category: def.category,
          unitPrice: def.unitPrice,
          costPrice: def.costPrice,
          quantityOnHand: def.quantityOnHand,
          reorderLevel: def.reorderLevel,
        },
      });
      for (const movement of def.movements) {
        await prisma.stockMovement.create({
          data: {
            organizationId: org.id,
            productId: product.id,
            type: movement.type,
            quantity: movement.quantity,
            note: movement.note,
            recordedByUserId: receptionist.id,
          },
        });
      }
    }

    // ------------------------------------------------------------------
    // CRM: leads at every pipeline stage + follow-ups + one conversion
    // ------------------------------------------------------------------
    console.log('Creating CRM leads...');
    const leadDefs: Array<{
      firstName: string;
      lastName: string;
      source: string;
      status: LeadStatus;
      branchId: string;
      followUp?: { daysFromNow: number; note: string; completed: boolean };
    }> = [
      {
        firstName: 'Priya',
        lastName: 'Sharma',
        source: 'Instagram',
        status: LeadStatus.NEW,
        branchId: downtown.id,
        followUp: {
          daysFromNow: 1,
          note: 'Send pricing sheet',
          completed: false,
        },
      },
      {
        firstName: 'Marcus',
        lastName: 'Lee',
        source: 'Walk-in',
        status: LeadStatus.CONTACTED,
        branchId: downtown.id,
        followUp: {
          daysFromNow: 0,
          note: 'Call to schedule trial',
          completed: false,
        },
      },
      {
        firstName: 'Sofia',
        lastName: 'Garcia',
        source: 'Referral',
        status: LeadStatus.QUALIFIED,
        branchId: uptown.id,
        followUp: {
          daysFromNow: 2,
          note: 'Offer 2-week trial',
          completed: false,
        },
      },
      {
        firstName: 'Ethan',
        lastName: 'Wu',
        source: 'Google Ads',
        status: LeadStatus.TRIAL,
        branchId: uptown.id,
        followUp: {
          daysFromNow: 4,
          note: 'Check in after trial day 3',
          completed: false,
        },
      },
      {
        firstName: 'Amara',
        lastName: 'Diallo',
        source: 'Facebook',
        status: LeadStatus.NEW,
        branchId: downtown.id,
      },
      {
        firstName: 'Leo',
        lastName: 'Martinez',
        source: 'Walk-in',
        status: LeadStatus.CONTACTED,
        branchId: downtown.id,
        followUp: {
          daysFromNow: 3,
          note: 'Follow up on annual plan interest',
          completed: true,
        },
      },
      {
        firstName: 'Grace',
        lastName: 'Kim',
        source: 'Referral',
        status: LeadStatus.LOST,
        branchId: uptown.id,
        followUp: {
          daysFromNow: -7,
          note: 'No response after 3 attempts',
          completed: true,
        },
      },
    ];
    for (const def of leadDefs) {
      const lead = await prisma.lead.create({
        data: {
          organizationId: org.id,
          branchId: def.branchId,
          firstName: def.firstName,
          lastName: def.lastName,
          email: `${def.firstName.toLowerCase()}.${def.lastName.toLowerCase()}@example.test`,
          phone: `+15550119${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
          source: def.source,
          status: def.status,
          notes:
            def.status === LeadStatus.LOST ? 'Chose a competitor gym.' : null,
          assignedToUserId: salesUser.id,
        },
      });
      if (def.followUp) {
        await prisma.leadFollowUp.create({
          data: {
            organizationId: org.id,
            leadId: lead.id,
            dueAt: new Date(
              Date.now() + def.followUp.daysFromNow * 24 * 60 * 60 * 1000,
            ),
            note: def.followUp.note,
            completedAt: def.followUp.completed ? new Date() : null,
            createdByUserId: salesUser.id,
          },
        });
      }
    }

    // One converted lead: WON + linked member, so the CRM conversion flow
    // has a real example on first login.
    const convertedLead = await prisma.lead.create({
      data: {
        organizationId: org.id,
        branchId: downtown.id,
        firstName: 'Hana',
        lastName: 'Sato',
        email: 'hana.sato@example.test',
        phone: '+1555011999',
        source: 'Instagram',
        status: LeadStatus.WON,
        assignedToUserId: salesUser.id,
        convertedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
    });
    const convertedMember = await prisma.member.create({
      data: {
        organizationId: org.id,
        primaryBranchId: downtown.id,
        memberCode: 'DEMO-1001',
        firstName: 'Hana',
        lastName: 'Sato',
        email: 'hana.sato@example.test',
        phone: '+1555011999',
        gender: 'FEMALE',
        status: 'ACTIVE',
        joinedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.lead.update({
      where: { id: convertedLead.id },
      data: { convertedMemberId: convertedMember.id },
    });

    // ------------------------------------------------------------------
    // Billing: membership payments + one refund + one one-off payment
    //
    // Payment/refund timestamps are deliberately kept inside the current
    // UTC calendar month: the revenue analytics (and the Owner OS card
    // fed by them) default to "this month", so rows dated 15 days back
    // would silently show zero revenue for the first half of any month.
    // ------------------------------------------------------------------
    console.log('Creating payments and refunds...');
    const now = new Date();
    const inMonth = (dayOffset: number, hour: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        Math.max(1, now.getDate() - dayOffset),
        hour,
        0,
      );
    const methods = [
      PaymentMethod.CASH,
      PaymentMethod.CARD,
      PaymentMethod.UPI,
      PaymentMethod.BANK_TRANSFER,
    ];
    let refundablePaymentId: string | null = null;
    for (const [index, membership] of memberships.slice(0, 8).entries()) {
      const payment = await prisma.payment.create({
        data: {
          organizationId: org.id,
          branchId: membership.branchId,
          memberId: membership.memberId,
          membershipId: membership.id,
          amount: membership.price,
          currency: 'USD',
          method: methods[index % methods.length],
          status: 'COMPLETED',
          note: 'Membership payment',
          recordedByUserId: accountant.id,
          createdAt: inMonth(index, 9 + (index % 8)),
        },
      });
      if (index === 1) refundablePaymentId = payment.id;
    }

    // A PT-session one-off payment (no membership link) + a refund
    await prisma.payment.create({
      data: {
        organizationId: org.id,
        branchId: downtown.id,
        memberId: members[2].id,
        amount: 40,
        currency: 'USD',
        method: PaymentMethod.CARD,
        status: 'COMPLETED',
        note: 'PT session',
        recordedByUserId: accountant.id,
        createdAt: inMonth(0, 11),
      },
    });
    if (refundablePaymentId) {
      // After the refunded payment (payment[1] = inMonth(1, 10)) but still
      // inside the current month.
      await prisma.refund.create({
        data: {
          organizationId: org.id,
          paymentId: refundablePaymentId,
          amount: 20,
          reason: 'Partial refund — membership upgrade credit',
          recordedByUserId: accountant.id,
          createdAt: inMonth(1, 12),
        },
      });
      // Mirror what PaymentsService.refund does: the payment's status
      // transitions to PARTIALLY_REFUNDED once a linked refund exists.
      await prisma.payment.update({
        where: { id: refundablePaymentId },
        data: { status: 'PARTIALLY_REFUNDED' },
      });
    }

    // ------------------------------------------------------------------
    // PT sessions: booked and completed, tied to the trainer staff profiles
    //
    // All anchored to today's date (morning = completed, late afternoon =
    // still scheduled): the PT Sessions page filters to the current day
    // (startFrom/endTo = today), so sessions dated yesterday/tomorrow
    // would be invisible on first login.
    // ------------------------------------------------------------------
    console.log('Creating PT sessions...');
    const trainer1Profile = await prisma.staffProfile.findUniqueOrThrow({
      where: { userId: trainer1.id },
    });
    const trainer2Profile = await prisma.staffProfile.findUniqueOrThrow({
      where: { userId: trainer2.id },
    });
    const today = new Date();
    const atHour = (hour: number) =>
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        hour,
        0,
        0,
      );
    const ptSessionDefs = [
      {
        memberId: members[2].id,
        trainerId: trainer1Profile.id,
        branchId: downtown.id,
        startTime: atHour(16),
        endTime: atHour(17),
        type: PtSessionType.PERSONAL_TRAINING,
        status: PtSessionStatus.SCHEDULED,
        price: 40,
        isPaid: false,
      },
      {
        memberId: members[5].id,
        trainerId: trainer2Profile.id,
        branchId: uptown.id,
        startTime: atHour(17),
        endTime: atHour(18),
        type: PtSessionType.PERSONAL_TRAINING,
        status: PtSessionStatus.SCHEDULED,
        price: 40,
        isPaid: false,
      },
      {
        memberId: members[0].id,
        trainerId: trainer1Profile.id,
        branchId: downtown.id,
        startTime: atHour(9),
        endTime: atHour(10),
        type: PtSessionType.PERSONAL_TRAINING,
        status: PtSessionStatus.COMPLETED,
        price: 40,
        isPaid: true,
        notes: 'Focus on squat depth and core bracing.',
      },
      {
        memberId: members[3].id,
        trainerId: trainer2Profile.id,
        branchId: uptown.id,
        startTime: atHour(10),
        endTime: atHour(11),
        type: PtSessionType.SMALL_GROUP,
        status: PtSessionStatus.COMPLETED,
        price: 25,
        isPaid: true,
      },
    ];
    for (const def of ptSessionDefs) {
      await prisma.ptSession.create({
        data: { organizationId: org.id, ...def },
      });
    }

    // ------------------------------------------------------------------
    // Member 360: notes, consents, goals
    // ------------------------------------------------------------------
    console.log('Creating member 360 data...');
    await prisma.memberNote.create({
      data: {
        organizationId: org.id,
        memberId: members[0].id,
        authorUserId: headTrainer.id,
        body: 'Started on Full Body Foundation. Good squat mechanics, needs work on shoulder mobility before overhead pressing.',
        pinned: true,
      },
    });
    await prisma.memberNote.create({
      data: {
        organizationId: org.id,
        memberId: members[4].id,
        authorUserId: headTrainer.id,
        body: 'Prefers morning sessions. Encourage consistency over intensity this month.',
      },
    });
    await prisma.memberConsent.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: members[0].id,
          type: 'WAIVER',
          granted: true,
          recordedByUserId: receptionist.id,
        },
        {
          organizationId: org.id,
          memberId: members[0].id,
          type: 'MARKETING',
          granted: true,
          recordedByUserId: receptionist.id,
        },
        {
          organizationId: org.id,
          memberId: members[4].id,
          type: 'WAIVER',
          granted: true,
          recordedByUserId: receptionist.id,
        },
        {
          organizationId: org.id,
          memberId: members[4].id,
          type: 'MARKETING',
          granted: false,
          recordedByUserId: receptionist.id,
          note: 'Opted out of promotional emails',
        },
      ],
    });
    const weightGoal = await prisma.memberGoal.create({
      data: {
        organizationId: org.id,
        memberId: members[0].id,
        title: 'Reach 85 kg',
        description: 'Steady fat loss while preserving strength.',
        category: 'WEIGHT_LOSS',
        status: 'ACTIVE',
        baselineValue: 92,
        targetValue: 85,
        targetUnit: 'kg',
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        targetDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        createdByUserId: headTrainer.id,
      },
    });
    await prisma.memberGoalMilestone.create({
      data: {
        organizationId: org.id,
        goalId: weightGoal.id,
        title: 'First 3 kg down',
        targetDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.memberGoal.create({
      data: {
        organizationId: org.id,
        memberId: members[6].id,
        title: 'Deadlift 140 kg',
        description: 'Linear progression on the 5x5 program.',
        category: 'STRENGTH',
        status: 'ACTIVE',
        baselineValue: 110,
        targetValue: 140,
        targetUnit: 'kg',
        startDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        targetDate: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000),
        createdByUserId: headTrainer.id,
      },
    });

    console.log('\nDemo seed complete.');
    console.log(`Organization: Demo Fitness Club (${org.slug})`);
    console.log(`Branches: Downtown, Uptown`);
    console.log(
      `Members: ${members.length + 1} (${firstNames.length} base + 1 converted from a lead)`,
    );
    console.log(
      `Workout plans: ${workoutPlans.length}, Diet plans: ${dietPlans.length}, Products: ${productDefs.length}`,
    );
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
