import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Today's sessions for the demo org, so the trainer dashboard can be
 * looked at with the states the reference shows: one in progress, one
 * still to start, one already done.
 *
 * `GET /workout-sessions/today` filters on `sessionDate` within today, so
 * the demo profile's historical sessions do not appear there at all --
 * the dashboard was reading 0/0 and therefore proving nothing about the
 * card layout.
 *
 * Development only; refuses production. Idempotent: it removes today's
 * sessions for the demo org before recreating them.
 */

const ORG_SLUG = 'demo-fitness-club';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed today’s sessions in production.');
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG } });
    if (!org) throw new Error(`No organization "${ORG_SLUG}". Run db:seed:dev first.`);

    const branch = await prisma.branch.findFirst({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) throw new Error('The demo organization has no branch.');

    const members = await prisma.member.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { memberCode: 'asc' },
      take: 4,
    });
    if (members.length < 3) throw new Error('Need at least three demo members.');

    // Reset today's rows so a re-run does not accumulate.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
    await prisma.workoutSession.deleteMany({
      where: {
        organizationId: org.id,
        sessionDate: { gte: startOfDay, lt: endOfDay },
      },
    });

    // A plan per member, so each card has a programme to name.
    const plan = await prisma.workoutPlan.findFirst({
      where: { organizationId: org.id, name: 'Lower/Upper Split — Block 2' },
    });

    const at = (hour: number, minute = 0) => {
      const when = new Date();
      when.setHours(hour, minute, 0, 0);
      return when;
    };

    // `WorkoutSessionStatus` is only IN_PROGRESS | COMPLETED -- a session
    // row exists once work has started, so there is no "scheduled" state
    // to seed. "To go" is therefore an *assignment* with no session yet,
    // which is the same thing the dashboard derives it from.
    const rows = [
      { member: members[0], status: 'COMPLETED' as const, hour: 7, minutes: 10 },
      { member: members[1], status: 'IN_PROGRESS' as const, hour: 9, minutes: 25 },
    ];
    // Assigned but not started: the "to go" card.
    const awaiting = members[2];

    if (!plan) throw new Error('No workout plan. Run db:seed:demo-profile first.');

    const ensureAssignment = async (memberId: string) => {
      const existing = await prisma.workoutAssignment.findFirst({
        where: { organizationId: org.id, memberId },
      });
      if (existing) return existing;
      return prisma.workoutAssignment.create({
        data: {
          organizationId: org.id,
          workoutPlanId: plan.id,
          memberId,
          status: 'ACTIVE',
          // Carries the time of day the dashboard's "to go" card shows:
          // the model has no scheduled-time field, and the assignment's
          // own start is the only real time attached to a plan that has
          // not begun.
          startDate: at(18, 30),
        },
      });
    };

    const assignment = await ensureAssignment(members[1].id);
    await ensureAssignment(awaiting.id);

    for (const row of rows) {
      await prisma.workoutSession.create({
        data: {
          organizationId: org.id,
          assignmentId: assignment.id,
          memberId: row.member.id,
          branchId: branch.id,
          sessionDate: at(row.hour, row.minutes),
          status: row.status,
          startedAt: at(row.hour, row.minutes),
          ...(row.status === 'COMPLETED'
            ? { completedAt: at(row.hour + 1) }
            : {}),
        },
      });
    }

    const done = rows.filter((r) => r.status === 'COMPLETED').length;
    const live = rows.filter((r) => r.status === 'IN_PROGRESS').length;

    console.log('\nToday’s sessions ready.\n');
    console.log(`  ${done} done · ${live} on the floor · 1 to go`);
    for (const row of rows) {
      console.log(
        `    ${at(row.hour, row.minutes).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}  ` +
          `${row.member.firstName} ${row.member.lastName} — ${row.status}`,
      );
    }
    console.log(
      `    18:30  ${awaiting.firstName} ${awaiting.lastName} — assigned, not started`,
    );
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
