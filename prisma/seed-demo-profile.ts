import 'dotenv/config';
import * as argon2 from 'argon2';
import {
  PrismaClient,
  AttendanceMethod,
  MemberAssessmentType,
  MemberAddressType,
  MemberConsentType,
  MemberDocumentCategory,
  MemberDocumentStatus,
  MemberGoalCategory,
  MemberGoalStatus,
  MemberStatus,
  MemberType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  RiskLevel,
  RiskTrend,
} from '@prisma/client';

/**
 * One fully-populated member, for demoing the profile screens.
 *
 * `seed-dev.ts` gives you breadth (15 members, staff, plans, attendance)
 * but every one of them is a row with a name and little else, so a
 * client looking at Member 360 sees mostly empty states and em-dashes.
 * This fills one profile across every tab so the screens have something
 * to show: goals with milestones, a progress history of measurements, a
 * signed waiver, a nutrition plan, attendance and payments over months.
 *
 * Refuses to run in production, and is idempotent -- it reuses the member
 * if it already exists, so it can be re-run to top up after adding a tab.
 *
 * Run: `npm run db:seed:demo-profile`
 */

const ORG_SLUG = 'demo-fitness-club';
/** Deliberately outside `seed-dev.ts`'s DEMO-0001..DEMO-0015 range.
 *  Sharing a code attaches this whole profile to one of its generic
 *  members: the upsert matches on (organizationId, memberCode), so
 *  DEMO-0001 silently resolved to "Alex Adams" and every child record
 *  below was written under his id. */
const MEMBER_CODE = 'SHOWCASE-0001';
const PORTAL_EMAIL = 'member@demogym.test';
const PORTAL_PASSWORD = 'DemoPass123!';
/** INR, to match the payment history below. See the plan lookup. */
const PLAN_NAME = 'Annual Elite (INR)';
const WORKOUT_PLAN_NAME = 'Lower/Upper Split — Block 2';
const DIET_PLAN_NAME = 'Maintenance — 2,100 kcal';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the demo profile with NODE_ENV=production.',
    );
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({
      where: { slug: ORG_SLUG },
    });
    if (!org) {
      throw new Error(
        `No organization "${ORG_SLUG}". Run \`npm run db:seed:dev\` first.`,
      );
    }

    const branch = await prisma.branch.findFirst({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) throw new Error('The demo organization has no branch.');

    // A trainer and a head trainer, so assignedTrainerId and the
    // author/recordedBy fields on the child records are real users rather
    // than dangling ids.
    const trainer = await prisma.user.findFirst({
      where: {
        organizationId: org.id,
        email: 'headtrainer@demogym.test',
        deletedAt: null,
      },
    });
    const owner = await prisma.user.findFirst({
      where: {
        organizationId: org.id,
        email: 'owner@demogym.test',
        deletedAt: null,
      },
    });
    if (!trainer) throw new Error('No head trainer in the demo organization.');

    // The plan this member is on, in the same currency as their payments.
    //
    // `seed-dev.ts` prices its plans in USD (499.99), and the app totals a
    // membership's price against that member's payments without converting
    // between currencies. Mixing an INR payment history with a USD plan
    // produced a "TOTAL INR 499.99" tile directly beside a membership card
    // reading "USD 499.99", and an "outstanding" of 27,499.01 that was
    // subtracting across two currencies. A dedicated INR plan keeps the
    // demo coherent without editing the shared plans the other 15
    // seeded members sit on.
    // `MembershipPlan` uniques only on `id` -- there is no
    // (organizationId, name) constraint to upsert against -- so this is
    // find-then-create rather than an upsert.
    const existingPlan = await prisma.membershipPlan.findFirst({
      where: { organizationId: org.id, name: PLAN_NAME },
    });
    const plan =
      existingPlan ??
      (await prisma.membershipPlan.create({
        data: {
          organizationId: org.id,
          name: PLAN_NAME,
          description:
            'Gym floor plus four personal-training sessions a month. Demo plan.',
          durationDays: 365,
          price: new Prisma.Decimal(21999),
          isActive: true,
        },
      }));

    // ---------------------------------------------------------------- member
    // Upsert on (organizationId, memberCode) -- the real unique key -- so
    // re-running tops the profile up instead of creating a second member.
    //
    // `update` restates every field rather than being empty. An empty
    // update is the "create only" shape, and for a script whose entire
    // job is "all information filled in" it is the wrong default: the
    // first run populates and every later one does nothing, so a stale
    // field survives a re-seed and looks like a bug in the seed.
    const profile = {
      primaryBranchId: branch.id,
      firstName: 'Ananya',
      lastName: 'Sharma',
      email: PORTAL_EMAIL,
      phone: '+919810001234',
      dateOfBirth: new Date('1994-04-18'),
      gender: 'FEMALE' as const,
      addressLine1: '14B, Green Meadows Apartments',
      addressLine2: '4th floor, flat 402',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560038',
      country: 'India',
      emergencyContactName: 'Rohit Sharma',
      emergencyContactPhone: '+919810001299',
      memberType: MemberType.GYM_PT,
      leadSource: 'Instagram',
      status: MemberStatus.ACTIVE,
      assignedTrainerId: trainer.id,
      notes:
        'Evening slot, prefers the 7pm strength session. Recovering from a ' +
        'left ankle sprain (Feb) — no deep knee flexion on the leg press yet. ' +
        'Prefers WhatsApp over email.',
      joinedAt: daysAgo(214),
    };
    const member = await prisma.member.upsert({
      where: {
        organizationId_memberCode: {
          organizationId: org.id,
          memberCode: MEMBER_CODE,
        },
      },
      create: {
        organizationId: org.id,
        memberCode: MEMBER_CODE,
        ...profile,
      },
      update: profile,
    });

    // ------------------------------------------------------------------ tags
    const tagNames: Array<[string, string]> = [
      ['Personal Training', '#6366f1'],
      ['Strength Focus', '#0ea5e9'],
      ['Lapsed Risk', '#f59e0b'],
    ];
    for (const [name, color] of tagNames) {
      const tag = await prisma.memberTag.upsert({
        where: { organizationId_name: { organizationId: org.id, name } },
        create: { organizationId: org.id, name, color },
        update: {},
      });
      await prisma.memberTagAssignment.upsert({
        where: { memberId_tagId: { memberId: member.id, tagId: tag.id } },
        create: {
          organizationId: org.id,
          memberId: member.id,
          tagId: tag.id,
          assignedByUserId: trainer.id,
        },
        update: {},
      });
    }

    // ------------------------------------------------------------- addresses
    await prisma.memberAddress.upsert({
      where: { id: `${member.id}-addr-home` },
      create: {
        id: `${member.id}-addr-home`,
        organizationId: org.id,
        memberId: member.id,
        type: MemberAddressType.HOME,
        isPrimary: true,
        addressLine1: '14B, Green Meadows Apartments',
        addressLine2: '4th floor, flat 402',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560038',
        country: 'India',
      },
      update: {},
    });
    await prisma.memberAddress.upsert({
      where: { id: `${member.id}-addr-work` },
      create: {
        id: `${member.id}-addr-work`,
        organizationId: org.id,
        memberId: member.id,
        type: MemberAddressType.WORK,
        isPrimary: false,
        addressLine1: 'Prestige Tech Park, Outer Ring Road',
        addressLine2: 'Building 3, 7th floor',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560103',
        country: 'India',
      },
      update: {},
    });

    // ---------------------------------------------------- emergency contact
    await prisma.memberEmergencyContact.deleteMany({ where: { memberId: member.id } });
    await prisma.memberEmergencyContact.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        name: 'Rohit Sharma',
        phone: '+919810001299',
        relationship: 'Spouse',
        isPrimary: true,
      },
    });

    // -------------------------------------------------------------- consents
    // A granted waiver and marketing consent, a declined photo release --
    // all three states on one profile, because a demo that only ever shows
    // "granted" does not show the screen.
    await prisma.memberConsent.deleteMany({ where: { memberId: member.id } });
    await prisma.memberConsent.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: member.id,
          type: MemberConsentType.WAIVER,
          granted: true,
          note: 'Signed at the Downtown desk on joining.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(214),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          type: MemberConsentType.DATA_PROCESSING,
          granted: true,
          note: 'Required by the retention policy.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(214),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          type: MemberConsentType.MARKETING,
          granted: true,
          note: 'Opted in for offers over WhatsApp.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(214),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          type: MemberConsentType.PHOTO_RELEASE,
          granted: false,
          note: 'Asked not to be photographed for the wall of honour.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(210),
        },
      ],
    });

    // ----------------------------------------------------------------- notes
    await prisma.memberNote.deleteMany({ where: { memberId: member.id } });
    await prisma.memberNote.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: member.id,
          authorUserId: trainer.id,
          body:
            'Cleared for full training. Ankle is pain-free at bodyweight and ' +
            'has passed single-leg calf raises. Cleared to progress load.',
          pinned: true,
          createdAt: daysAgo(38),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          authorUserId: trainer.id,
          body:
            'Requested to be billed on the 1st rather than her join date. ' +
            'Moved to the 1st so the reminder lands before it renews.',
          pinned: false,
          createdAt: daysAgo(96),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          authorUserId: owner?.id,
          body:
            'Asked about holding her spot during a work trip (12–19 of next ' +
            'month). Agreed to two freeze days rather than extending billing.',
          pinned: false,
          createdAt: daysAgo(12),
        },
      ],
    });

    // -------------------------------------------------- assessments/measurements
    // Two sessions four months apart, so the "progress" view has a trend
    // to draw rather than a single row.
    await prisma.memberAssessment.deleteMany({
      where: { memberId: member.id, fitnessResults: { none: {} } },
    });
    const initial = await prisma.memberAssessment.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        type: MemberAssessmentType.INITIAL,
        notes:
          'Induction assessment. Desk job, no prior training. Blood pressure ' +
          'mildly raised; advised to log it weekly.',
        conductedByUserId: trainer.id,
        conductedAt: daysAgo(214),
      },
    });
    const progress = await prisma.memberAssessment.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        type: MemberAssessmentType.PROGRESS,
        notes:
          'Four-month re-test. Lean mass up, resting heart rate down, blood ' +
          'pressure back inside normal range.',
        conductedByUserId: trainer.id,
        conductedAt: daysAgo(31),
      },
    });

    const measurement = (
      assessmentId: string,
      at: Date,
      weightKg: number,
      bodyFatPercent: number,
      waistCm: number,
      restingHeartRate: number,
      systolic: number,
      diastolic: number,
    ) => ({
      organizationId: org.id,
      memberId: member.id,
      assessmentId,
      recordedAt: at,
      weightKg,
      heightCm: 165,
      bodyFatPercent,
      muscleMassKg: weightKg * 0.42,
      waistCm,
      hipCm: 96,
      chestCm: 88,
      restingHeartRate,
      bloodPressureSystolic: systolic,
      bloodPressureDiastolic: diastolic,
      recordedByUserId: trainer.id,
    });

    await prisma.memberMeasurement.deleteMany({ where: { memberId: member.id } });
    await prisma.memberMeasurement.createMany({
      data: [
        measurement(initial.id, daysAgo(214), 68.4, 27.8, 84, 74, 132, 86),
        measurement(progress.id, daysAgo(31), 63.1, 23.4, 78, 66, 121, 79),
      ],
    });

    // ------------------------------------------------------------------ goals
    await prisma.memberGoal.deleteMany({ where: { memberId: member.id } });
    const strengthGoal = await prisma.memberGoal.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        title: 'Deadlift 90 kg for a clean triple',
        description:
          'Six weeks out from a powerlifting meet. Three white sessions a week.',
        category: MemberGoalCategory.STRENGTH,
        status: MemberGoalStatus.ACTIVE,
        targetValue: 90,
        targetUnit: 'kg',
        baselineValue: 55,
        startDate: daysAgo(120),
        targetDate: daysAhead(38),
        createdByUserId: trainer.id,
      },
    });
    await prisma.memberGoalMilestone.createMany({
      data: [
        {
          organizationId: org.id,
          goalId: strengthGoal.id,
          title: 'Deadlift 70 kg x 5',
          value: new Prisma.Decimal(70),
          achievedAt: daysAgo(60),
        },
        {
          organizationId: org.id,
          goalId: strengthGoal.id,
          title: 'Deadlift 80 kg x 3',
          value: new Prisma.Decimal(80),
          achievedAt: daysAgo(18),
        },
        {
          organizationId: org.id,
          goalId: strengthGoal.id,
          title: 'Deadlift 90 kg x 1',
          value: new Prisma.Decimal(90),
          targetDate: daysAhead(38),
          note: 'Attempt at the meet. Three weeks of accumulation first.',
        },
      ],
    });
    await prisma.memberGoal.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        title: 'Get under 60 kg',
        description: 'Reached it in week 14. Maintenance from here.',
        category: MemberGoalCategory.WEIGHT_LOSS,
        status: MemberGoalStatus.ACHIEVED,
        targetValue: 60,
        targetUnit: 'kg',
        baselineValue: 68.4,
        startDate: daysAgo(200),
        targetDate: daysAgo(20),
        achievedAt: daysAgo(22),
        createdByUserId: trainer.id,
      },
    });

    // ------------------------------------------------------------------ risk
    await prisma.memberRiskProfile.upsert({
      where: { memberId: member.id },
      create: {
        organizationId: org.id,
        memberId: member.id,
        overallScore: 18,
        riskLevel: RiskLevel.LOW,
        trend: RiskTrend.IMPROVING,
        contributingFactors: [
          { factor: 'MISSED_SESSIONS', weight: 3, detail: '2 missed in 30 days' },
          { factor: 'TRAVEL', weight: 2, detail: 'Trip booked 12–19 next month' },
        ],
        protectiveFactors: [
          'Three consecutive months of attendance',
          'Active goal with a milestone due this week',
          'Waiver and data-processing consent on file',
        ],
        computedAt: daysAgo(1),
      },
      update: {},
    });

    // ------------------------------------------------------------ membership
    await prisma.membership.deleteMany({ where: { memberId: member.id } });
    const membership = await prisma.membership.create({
      data: {
        organizationId: org.id,
        branchId: branch.id,
        memberId: member.id,
        membershipPlanId: plan.id,
        // Snapshotted at purchase rather than read off the plan, so a
        // later price change does not rewrite what this member agreed to.
        price: plan.price,
        status: 'ACTIVE',
        startDate: daysAgo(30),
        endDate: daysAhead(335),
        autoRenew: true,
      },
    });

    // ------------------------------------------------------------- payments
    await prisma.payment.deleteMany({ where: { memberId: member.id } });
    await prisma.payment.createMany({
      data: [
        {
          organizationId: org.id,
          branchId: branch.id,
          memberId: member.id,
          membershipId: membership.id,
          amount: new Prisma.Decimal(21999),
          currency: 'INR',
          method: PaymentMethod.UPI,
          status: PaymentStatus.COMPLETED,
          note: 'Annual Pro — paid by UPI on the 1st.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(30),
        },
        {
          organizationId: org.id,
          branchId: branch.id,
          memberId: member.id,
          membershipId: membership.id,
          amount: new Prisma.Decimal(6000),
          currency: 'INR',
          method: PaymentMethod.CARD,
          status: PaymentStatus.COMPLETED,
          note: 'Six personal-training sessions, prepaid.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(30),
        },
        {
          organizationId: org.id,
          branchId: branch.id,
          memberId: member.id,
          amount: new Prisma.Decimal(2499),
          currency: 'INR',
          method: PaymentMethod.BANK_TRANSFER,
          status: PaymentStatus.COMPLETED,
          note: 'Renewal — bank transfer.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(395),
        },
        {
          organizationId: org.id,
          branchId: branch.id,
          memberId: member.id,
          amount: new Prisma.Decimal(1500),
          currency: 'INR',
          method: PaymentMethod.CASH,
          status: PaymentStatus.REFUNDED,
          note: 'Two unused PT sessions, refunded on request.',
          recordedByUserId: owner?.id,
          createdAt: daysAgo(88),
        },
      ],
    });

    // ------------------------------------------------------------ attendance
    // Four months, three visits most weeks, so retention and the streak
    // figures on the overview have something real behind them. Starting at
    // day 0 rather than 2 is deliberate: the streak tile counts consecutive
    // days, and a gap at the top would have shown "0 day streak" on a
    // member who trains three times a week.
    await prisma.attendance.deleteMany({ where: { memberId: member.id } });
    const methods = [
      AttendanceMethod.QR,
      AttendanceMethod.KIOSK,
      AttendanceMethod.MANUAL,
    ];
    const attendances: Prisma.AttendanceCreateManyInput[] = [];
    let i = 0;
    for (let day = 190; day >= 0; day -= 2) {
      // Skip some weeks so the number is not a suspiciously perfect grid.
      // `day > 0` matters: 0 % 14 is 0, so an unguarded test drops today
      // and the streak tile reads "0 day streak" on a member who just
      // trained.
      if (day > 0 && day % 14 === 0) continue;
      const checkIn = new Date(daysAgo(day));
      checkIn.setHours(18, 30 + ((i * 7) % 40), 0, 0);
      const checkOut = new Date(checkIn);
      checkOut.setMinutes(checkOut.getMinutes() + 60 + ((i * 11) % 45));
      attendances.push({
        organizationId: org.id,
        branchId: branch.id,
        memberId: member.id,
        checkInAt: checkIn,
        checkOutAt: checkOut,
        method: methods[i % methods.length],
      });
      i += 1;
    }
    await prisma.attendance.createMany({ data: attendances });

    // ---------------------------------------------------------- status history
    await prisma.memberStatusHistory.deleteMany({ where: { memberId: member.id } });
    await prisma.memberStatusHistory.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: member.id,
          fromStatus: null,
          toStatus: MemberStatus.ACTIVE,
          reason: 'Joined on the Annual Pro plan.',
          changedByUserId: owner?.id,
          createdAt: daysAgo(214),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          fromStatus: MemberStatus.ACTIVE,
          toStatus: MemberStatus.INACTIVE,
          reason: 'Two-week ankle sprain — paused billing, kept the membership.',
          changedByUserId: owner?.id,
          createdAt: daysAgo(64),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          fromStatus: MemberStatus.INACTIVE,
          toStatus: MemberStatus.ACTIVE,
          reason: 'Cleared by the trainer; resumed the evening slot.',
          changedByUserId: trainer.id,
          createdAt: daysAgo(38),
        },
      ],
    });

    // ------------------------------------------------------------- follow-ups
    await prisma.memberFollowUp.deleteMany({ where: { memberId: member.id } });
    await prisma.memberFollowUp.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: member.id,
          title: 'Confirm the freeze days for her trip',
          description:
            'She asked to hold her slot 12–19 of next month. Two freeze days, ' +
            'not an extension — tell her before she books the flight.',
          dueAt: daysAhead(3),
          priority: 'HIGH',
          createdByUserId: owner?.id,
          assignedToUserId: owner?.id,
        },
        {
          organizationId: org.id,
          memberId: member.id,
          title: 'Book the powerlifting meet slot',
          description: 'Meet is in 38 days. Registration closes in two weeks.',
          dueAt: daysAhead(10),
          priority: 'MEDIUM',
          createdByUserId: trainer.id,
          assignedToUserId: trainer.id,
        },
        {
          organizationId: org.id,
          memberId: member.id,
          title: 'Six PT sessions used — sell the next block',
          description: 'She finished the prepaid block this week.',
          completedAt: daysAgo(5),
          priority: 'LOW',
          createdByUserId: owner?.id,
          assignedToUserId: owner?.id,
        },
      ],
    });

    // ------------------------------------------------------------- screening
    await prisma.memberScreening.deleteMany({ where: { memberId: member.id } });
    await prisma.memberScreening.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        assessmentId: initial.id,
        responses: {
          chestPain: false,
          heartCondition: false,
          highBloodPressure: true,
          diabetes: false,
          jointSurgery: false,
          currentMedication: 'None',
          doctorCleared: true,
          notes:
            'Reports mild hypertension. BP 132/86 at intake, re-checked as ' +
            'normal in the four-month retest.',
        },
        flaggedForMedicalClearance: false,
        notes: 'Cleared for full training with a BP re-check each month.',
        completedAt: daysAgo(214),
        recordedByUserId: trainer.id,
      },
    });

    // --------------------------------------------------------------- loyalty
    // One account per member per org (the unique constraint is on the
    // pair, not memberId alone), and the ledger is keyed by member.
    await prisma.loyaltyAccount.deleteMany({ where: { memberId: member.id } });
    await prisma.loyaltyAccount.create({
      data: {
        organizationId: org.id,
        memberId: member.id,
        points: 1240,
        tier: 'GOLD',
      },
    });
    await prisma.loyaltyLedgerEntry.deleteMany({ where: { memberId: member.id } });
    await prisma.loyaltyLedgerEntry.createMany({
      data: [
        {
          organizationId: org.id,
          memberId: member.id,
          points: 2200,
          reason: 'Annual Pro purchase',
          referenceType: 'PAYMENT',
          createdAt: daysAgo(30),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          points: 1200,
          reason: 'Member referral — a friend joined on her recommendation',
          referenceType: 'REFERRAL',
          createdAt: daysAgo(75),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          points: -300,
          reason: 'Two missed sessions',
          referenceType: 'ATTENDANCE',
          createdAt: daysAgo(40),
        },
        {
          organizationId: org.id,
          memberId: member.id,
          points: 1860,
          reason: 'Renewal — bank transfer',
          referenceType: 'PAYMENT',
          createdAt: daysAgo(395),
        },
      ],
    });

    // ------------------------------------------------- exercises + workout
    // `Exercise` uniques on (organizationId, name) and `seed-dev.ts` seeds
    // none, so the library has to be created before anything can reference
    // it. A workout plan stores its exercises as JSON keyed by exerciseId,
    // so a missing row would not fail the insert -- it would just render as
    // an exercise with no name, which looks like a broken plan rather than
    // a missing seed.
    const exerciseNames: Array<[string, string, string]> = [
      ['Barbell Back Squat', 'Legs', 'Barbell'],
      ['Conventional Deadlift', 'Back', 'Barbell'],
      ['Bench Press', 'Chest', 'Barbell'],
      ['Barbell Row', 'Back', 'Barbell'],
      ['Romanian Deadlift', 'Hamstrings', 'Barbell'],
      ['Overhead Press', 'Shoulders', 'Barbell'],
      ['Dumbbell Curl', 'Biceps', 'Dumbbells'],
      ['Plank', 'Core', 'Bodyweight'],
    ];
    const exerciseIdByName = new Map<string, string>();
    for (const [name, muscleGroup, equipment] of exerciseNames) {
      const existing = await prisma.exercise.findFirst({
        where: { organizationId: org.id, name },
      });
      const row =
        existing ??
        (await prisma.exercise.create({
          data: { organizationId: org.id, name, muscleGroup, equipment },
        }));
      exerciseIdByName.set(name, row.id);
    }

    await prisma.workoutAssignment.deleteMany({ where: { memberId: member.id } });
    const workoutPlan =
      (await prisma.workoutPlan.findFirst({
        where: { organizationId: org.id, name: WORKOUT_PLAN_NAME },
      })) ??
      (await prisma.workoutPlan.create({
        data: {
          organizationId: org.id,
          name: WORKOUT_PLAN_NAME,
          description:
            'Lower/upper split, three days a week. Built around the deadlift ' +
            'goal; nothing here loads the ankle past neutral.',
          createdByUserId: trainer.id,
          exercises: [
            {
              exerciseId: exerciseIdByName.get('Conventional Deadlift'),
              order: 1,
              sets: 4,
              reps: '5',
              restSeconds: 180,
              notes: 'Brace hard. Reset every rep.',
            },
            {
              exerciseId: exerciseIdByName.get('Barbell Back Squat'),
              order: 2,
              sets: 3,
              reps: '6',
              restSeconds: 150,
              notes: 'Box squat to 3 reps below parallel for the first two weeks.',
            },
            {
              exerciseId: exerciseIdByName.get('Romanian Deadlift'),
              order: 3,
              sets: 3,
              reps: '8',
              restSeconds: 120,
            },
            {
              exerciseId: exerciseIdByName.get('Plank'),
              order: 4,
              sets: 3,
              reps: '60s',
              restSeconds: 60,
            },
          ],
        },
      }));

    const workoutAssignment = await prisma.workoutAssignment.create({
      data: {
        organizationId: org.id,
        workoutPlanId: workoutPlan.id,
        memberId: member.id,
        assignedByUserId: trainer.id,
        status: 'ACTIVE',
        startDate: daysAgo(120),
        notes: 'Start each session with the deadlift block.',
      },
    });

    // Three completed sessions with real sets, so the exercise-history panel
    // has a progression to draw rather than "No workout history yet". The
    // deadlift load rises across them, which is the trend the panel exists
    // to show.
    const deadlift = exerciseIdByName.get('Conventional Deadlift')!;
    const squat = exerciseIdByName.get('Barbell Back Squat')!;
    await prisma.workoutSession.deleteMany({ where: { memberId: member.id } });
    const sessions: Array<{
      day: number;
      deadliftKg: number;
      squatKg: number;
    }> = [
      { day: 42, deadliftKg: 70, squatKg: 60 },
      { day: 21, deadliftKg: 77.5, squatKg: 65 },
      { day: 7, deadliftKg: 82.5, squatKg: 70 },
    ];
    for (const s of sessions) {
      const when = daysAgo(s.day);
      const started = new Date(when);
      started.setHours(18, 30, 0, 0);
      const session = await prisma.workoutSession.create({
        data: {
          organizationId: org.id,
          assignmentId: workoutAssignment.id,
          memberId: member.id,
          branchId: branch.id,
          sessionDate: when,
          status: 'COMPLETED',
          startedAt: started,
          completedAt: new Date(started.getTime() + 70 * 60_000),
          notes: 'Felt strong. Belt from 65kg up.',
          createdByUserId: trainer.id,
        },
      });
      await prisma.workoutSessionSet.createMany({
        data: [
          {
            organizationId: org.id,
            sessionId: session.id,
            exerciseId: deadlift,
            setNumber: 1,
            reps: 5,
            weightKg: new Prisma.Decimal(s.deadliftKg),
          },
          {
            organizationId: org.id,
            sessionId: session.id,
            exerciseId: deadlift,
            setNumber: 2,
            reps: 5,
            weightKg: new Prisma.Decimal(s.deadliftKg),
          },
          {
            organizationId: org.id,
            sessionId: session.id,
            exerciseId: deadlift,
            setNumber: 3,
            reps: 5,
            weightKg: new Prisma.Decimal(s.deadliftKg * 0.9),
          },
          {
            organizationId: org.id,
            sessionId: session.id,
            exerciseId: squat,
            setNumber: 1,
            reps: 6,
            weightKg: new Prisma.Decimal(s.squatKg),
          },
          {
            organizationId: org.id,
            sessionId: session.id,
            exerciseId: squat,
            setNumber: 2,
            reps: 6,
            weightKg: new Prisma.Decimal(s.squatKg * 0.9),
          },
        ],
      });
    }

    // ------------------------------------------------------------------ diet
    await prisma.dietAssignment.deleteMany({ where: { memberId: member.id } });
    const dietPlan =
      (await prisma.dietPlan.findFirst({
        where: { organizationId: org.id, name: DIET_PLAN_NAME },
      })) ??
      (await prisma.dietPlan.create({
        data: {
          organizationId: org.id,
          name: DIET_PLAN_NAME,
          description:
            'Maintenance now that the weight goal is met — enough protein to ' +
            'hold lean mass through the strength block.',
          targetCalories: 2100,
          targetProteinG: new Prisma.Decimal(135),
          targetCarbsG: new Prisma.Decimal(210),
          targetFatG: new Prisma.Decimal(65),
          createdByUserId: trainer.id,
          items: [
            { meal: 'Breakfast', detail: '4 egg whites, 2 whole, oats, berries' },
            { meal: 'Lunch', detail: 'Grilled chicken, rice, salad' },
            { meal: 'Pre-training', detail: 'Banana and toast, 90 minutes out' },
            { meal: 'Dinner', detail: 'Paneer or fish, roti, vegetables' },
            { meal: 'Supper', detail: 'Curd, walnuts' },
          ],
        },
      }));
    await prisma.dietAssignment.create({
      data: {
        organizationId: org.id,
        dietPlanId: dietPlan.id,
        memberId: member.id,
        assignedByUserId: trainer.id,
        status: 'ACTIVE',
        startDate: daysAgo(20),
        notes: 'Weigh in on Sunday and message me the number.',
      },
    });

    // ------------------------------------------------------ portal login
    // A member with a login, so the client-side profile (`/portal`) can be
    // shown in the member's own view rather than only the staff one.
    const passwordHash = await argon2.hash(PORTAL_PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: PORTAL_EMAIL },
      create: {
        organizationId: org.id,
        email: PORTAL_EMAIL,
        passwordHash,
        firstName: 'Ananya',
        lastName: 'Sharma',
        phone: '+919810001234',
        status: 'ACTIVE',
      },
      update: {},
    });
    const memberRole = await prisma.role.findFirst({
      where: {
        key: 'MEMBER',
        OR: [{ organizationId: org.id }, { isSystem: true }],
      },
    });
    if (memberRole) {
      // `user_roles` uniques on (userId, roleId, branchId) with a
      // nullable branchId, which Prisma cannot express as a compound
      // `where` -- passing null for a nullable key is a type error, and
      // omitting it is a different key. Clear-then-create is exact and
      // re-runnable; there is exactly one org-wide grant wanted here.
      await prisma.userRole.deleteMany({
        where: { userId: user.id, roleId: memberRole.id },
      });
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: memberRole.id,
          organizationId: org.id,
        },
      });
    }
    await prisma.member.update({
      where: { id: member.id },
      data: { userId: user.id },
    });

    // --------------------------------------------------------------- summary
    const [tags, addrs, notes, goals, payments, visits] = await Promise.all([
      prisma.memberTagAssignment.count({ where: { memberId: member.id } }),
      prisma.memberAddress.count({ where: { memberId: member.id } }),
      prisma.memberNote.count({ where: { memberId: member.id } }),
      prisma.memberGoal.count({ where: { memberId: member.id } }),
      prisma.payment.count({ where: { memberId: member.id } }),
      prisma.attendance.count({ where: { memberId: member.id } }),
    ]);

    console.log('\nDemo profile ready.\n');
    console.log(`  Member:   ${member.firstName} ${member.lastName} (${member.memberCode})`);
    console.log(`  Member id: ${member.id}`);
    console.log(`  Org:      ${org.name}`);
    console.log(`  Staff view: /members/${member.id}`);
    console.log(`  Member view: sign in as ${PORTAL_EMAIL} / ${PORTAL_PASSWORD} → /portal`);
    console.log(
      `\n  ${tags} tags · ${addrs} addresses · ${notes} notes · ${goals} goals · ` +
        `${payments} payments · ${visits} visits`,
    );
    console.log(
      '  plus: consents, 2 assessments, 2 measurement sets, screening, risk',
    );
    console.log('  profile, 3 status changes, 3 follow-ups, loyalty ledger, membership\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
