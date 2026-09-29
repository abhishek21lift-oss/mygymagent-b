import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * A real exercise library, so "Browse by muscle" has something to browse.
 *
 * The `exercises` table was empty, which left two problems: the
 * muscle-category cards had no counts to show, and a workout plan stores
 * its exercises as a JSON array keyed by `exerciseId` -- so a plan
 * referencing a missing exercise does not fail on insert, it renders as
 * an exercise with no name. That is worse than an error.
 *
 * `Exercise` carries only `name`, `muscleGroup`, `equipment`,
 * `description` and `videoUrl`. There is no `difficulty`,
 * `movementPattern`, `trainingGoal` or `secondaryMuscle` in the schema,
 * so nothing here invents those -- if a screen needs them, that is a
 * schema decision, not a seed change.
 *
 * Development only. Refuses to run in production, and is idempotent:
 * the unique key is (organizationId, name), so a re-run tops up
 * descriptions and equipment without duplicating anything.
 *
 * Run: `npm run db:seed:exercises`
 */

const ORG_SLUG = 'demo-fitness-club';

/** Muscle group -> exercises. Grouped by what the movement trains, not by
 *  equipment, so the category cards read as anatomy the way a member
 *  would expect rather than as a catalogue of machines. */
const LIBRARY: Record<
  string,
  Array<{ name: string; equipment: string; description: string }>
> = {
  Chest: [
    {
      name: 'Barbell Bench Press',
      equipment: 'Barbell',
      description:
        'The standard horizontal press. Sets the width of the upper chest and is the main strength lift for pressing.',
    },
    {
      name: 'Incline Dumbbell Press',
      equipment: 'Dumbbells',
      description:
        '30-45 degrees, pairing the press with shoulder movement to reach the upper chest.',
    },
    {
      name: 'Push-Up',
      equipment: 'Bodyweight',
      description:
        'The same pattern as the bench press with no load. Used for volume and as a warm-up.',
    },
    {
      name: 'Cable Fly',
      equipment: 'Cable',
      description:
        'Constant tension through the stretch, which is where this movement does its work.',
    },
    {
      name: 'Dumbbell Pullover',
      equipment: 'Dumbbells',
      description:
        'Reaches the upper chest from a shoulder-dominant angle. Light, long stretch.',
    },
  ],
  Back: [
    {
      name: 'Conventional Deadlift',
      equipment: 'Barbell',
      description:
        'Hip hinge under load, loaded by the back, glutes and hamstrings together.',
    },
    {
      name: 'Barbell Row',
      equipment: 'Barbell',
      description:
        'Bent-over horizontal pull. Thickness through the mid-back rather than width.',
    },
    {
      name: 'Pull-Up',
      equipment: 'Bodyweight',
      description:
        'Vertical pull from a hanging position. Scales with added load for progression.',
    },
    {
      name: 'Lat Pulldown',
      equipment: 'Cable',
      description:
        'The machine equivalent of a pull-up, and the usual entry point to the vertical pull pattern.',
    },
    {
      name: 'Seated Cable Row',
      equipment: 'Cable',
      description:
        'Rowing with the torso supported, so the mid-back rather than the lower back does the work.',
    },
    {
      name: 'Face Pull',
      equipment: 'Cable',
      description:
        'High cable to the face, pulling the elbows apart. Rear delts and upper back.',
    },
  ],
  Legs: [
    {
      name: 'Barbell Back Squat',
      equipment: 'Barbell',
      description:
        'The foundational lower-body lift. Depth, stance and bar placement all change which muscles lead.',
    },
    {
      name: 'Front Squat',
      equipment: 'Barbell',
      description:
        'Bar on the front of the shoulders, which limits load and demands a more upright torso.',
    },
    {
      name: 'Leg Press',
      equipment: 'Machine',
      description:
        'Squat pattern on a fixed path. Useful for heavy loading when a barbell is not available.',
    },
    {
      name: 'Bulgarian Split Squat',
      equipment: 'Dumbbells',
      description:
        'Single-leg, rear-foot-elevated. Finds and trains leg asymmetries.',
    },
    {
      name: 'Walking Lunge',
      equipment: 'Dumbbells',
      description:
        'Loaded stride, so the legs work through a longer range than a stationary split squat.',
    },
    {
      name: 'Leg Extension',
      equipment: 'Machine',
      description: 'Knee isolation for the quadriceps.',
    },
  ],
  Hamstrings: [
    {
      name: 'Romanian Deadlift',
      equipment: 'Barbell',
      description:
        'Hinge with soft knees, lowering the bar to the legs rather than the floor. Hamstring dominant.',
    },
    {
      name: 'Lying Leg Curl',
      equipment: 'Machine',
      description: 'Prone knee flexion. Direct hamstring isolation.',
    },
    {
      name: 'Good Morning',
      equipment: 'Barbell',
      description:
        'Hip hinge with the bar on the back, similar to the RDL but usually lighter.',
    },
    {
      name: 'Nordic Curl',
      equipment: 'Bodyweight',
      description:
        'Kneeling hamstring work with the ankles anchored. Very demanding on the hamstrings.',
    },
  ],
  Glutes: [
    {
      name: 'Barbell Hip Thrust',
      equipment: 'Barbell',
      description:
        'Loaded hip extension from a seated position. Heavily glute-dominant and safe to load.',
    },
    {
      name: 'Cable Pull-Through',
      equipment: 'Cable',
      description:
        'Hip extension with the cable low, so the glutes work against a constant pull.',
    },
    {
      name: 'Glute Bridge',
      equipment: 'Bodyweight',
      description: 'The unloaded version of the hip thrust, and a common warm-up.',
    },
  ],
  Shoulders: [
    {
      name: 'Overhead Press',
      equipment: 'Barbell',
      description:
        'Standing vertical press. A strict press keeps this a shoulder movement; a push press adds leg drive.',
    },
    {
      name: 'Seated Dumbbell Press',
      equipment: 'Dumbbells',
      description: 'Vertical press with back support, so the traps cannot assist.',
    },
    {
      name: 'Lateral Raise',
      equipment: 'Dumbbells',
      description: 'Shoulder abduction to the side. Trains the deltoid head the presses miss.',
    },
    {
      name: 'Rear Delt Fly',
      equipment: 'Dumbbells',
      description:
        'Bent-over shoulder abduction, targeting the rear deltoid and upper back.',
    },
    {
      name: 'Arnold Press',
      equipment: 'Dumbbells',
      description:
        'Rotation-plus-press, running through the arc the other presses skip.',
    },
  ],
  Biceps: [
    {
      name: 'Barbell Curl',
      equipment: 'Barbell',
      description:
        'The two-arm curl. Heaviest option for the biceps, and the one most affected by cheating.',
    },
    {
      name: 'Incline Dumbbell Curl',
      equipment: 'Dumbbells',
      description:
        'Arms angled down, which lengthens the biceps at the shoulder and makes the curl harder.',
    },
    {
      name: 'Hammer Curl',
      equipment: 'Dumbbells',
      description:
        'Neutral grip, loading the brachialis and forearm alongside the biceps.',
    },
    {
      name: 'Preacher Curl',
      equipment: 'Machine',
      description: 'Elbow supported, which removes momentum from the movement.',
    },
  ],
  Triceps: [
    {
      name: 'Close-Grip Bench Press',
      equipment: 'Barbell',
      description: 'A pressing movement used to load the triceps rather than the chest.',
    },
    {
      name: 'Triceps Pushdown',
      equipment: 'Cable',
      description: 'Elbow extension against a cable. The standard isolation movement.',
    },
    {
      name: 'Overhead Triceps Extension',
      equipment: 'Dumbbell',
      description: 'Extension above the head, which puts the triceps in a strong shortened position.',
    },
    {
      name: 'Skull Crusher',
      equipment: 'Barbell',
      description:
        'Lying elbow extension. Heavy, and one of the few triceps lifts that tolerates a barbell.',
    },
  ],
  Core: [
    {
      name: 'Plank',
      equipment: 'Bodyweight',
      description:
        'Isometric anti-extension. The entry point to core training and the most-used warm-up there is.',
    },
    {
      name: 'Hanging Leg Raise',
      equipment: 'Bodyweight',
      description:
        'Hip flexion from a hanging position, which loads the lower abdominals hard.',
    },
    {
      name: 'Cable Woodchop',
      equipment: 'Cable',
      description:
        'Loaded rotation through the trunk. Dialling the resistance in lets the quality be measured.',
    },
    {
      name: 'Ab Wheel Rollout',
      equipment: 'Bodyweight',
      description:
        'The hardest anti-extension movement there is, and the reason it needs a progression.',
    },
    {
      name: 'Russian Twist',
      equipment: 'Bodyweight',
      description: 'Seated rotation, mostly for the obliques.',
    },
  ],
  Calves: [
    {
      name: 'Standing Calf Raise',
      equipment: 'Machine',
      description: 'Weight through the toes, working the gastrocnemius with the legs straight.',
    },
    {
      name: 'Seated Calf Raise',
      equipment: 'Machine',
      description: 'Bent knee, isolating the soleus beneath the gastrocnemius.',
    },
    {
      name: 'Single-Leg Calf Raise',
      equipment: 'Bodyweight',
      description:
        'One leg at a time, which both loads it heavily and finds the weaker side.',
    },
  ],
  Forearms: [
    {
      name: 'Farmer Carry',
      equipment: 'Dumbbells',
      description:
        'Loaded at the sides for distance. Grip, trunk and posture all under load at once.',
    },
    {
      name: 'Wrist Curl',
      equipment: 'Dumbbells',
      description: 'Wrist flexion for the forearm flexors.',
    },
    {
      name: 'Reverse Curl',
      equipment: 'Barbell',
      description: 'Overhand grip curl, which inverts the pull to the extensor side.',
    },
  ],
  Traps: [
    {
      name: 'Barbell Shrug',
      equipment: 'Barbell',
      description: 'Shoulder elevation under load. Simple, and effective for the upper traps.',
    },
    {
      name: 'Cable Shrug',
      equipment: 'Cable',
      description: 'The same movement with constant cable tension at the top.',
    },
  ],
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the exercise library seed in production.');
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

    let created = 0;
    let updated = 0;
    const byGroup = new Map<string, number>();

    for (const [muscleGroup, entries] of Object.entries(LIBRARY)) {
      for (const entry of entries) {
        const existing = await prisma.exercise.findFirst({
          where: { organizationId: org.id, name: entry.name },
        });
        if (existing) {
          await prisma.exercise.update({
            where: { id: existing.id },
            data: {
              muscleGroup,
              equipment: entry.equipment,
              description: entry.description,
            },
          });
          updated += 1;
        } else {
          await prisma.exercise.create({
            data: {
              organizationId: org.id,
              name: entry.name,
              muscleGroup,
              equipment: entry.equipment,
              description: entry.description,
            },
          });
          created += 1;
        }
        byGroup.set(muscleGroup, (byGroup.get(muscleGroup) ?? 0) + 1);
      }
    }

    const total = await prisma.exercise.count({
      where: { organizationId: org.id },
    });

    console.log('\nExercise library ready.\n');
    console.log(`  Org:     ${org.name}`);
    console.log(`  Created: ${created}   updated: ${updated}`);
    console.log(`  Total:   ${total} across ${byGroup.size} muscle groups\n`);
    for (const [group, count] of [...byGroup].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${group.padEnd(12)} ${String(count).padStart(2)}`);
    }
    console.log(
      '\n  Note: Exercise has no difficulty / movementPattern / trainingGoal\n' +
        '  columns. Anything needing those is a schema decision, not seed data.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
