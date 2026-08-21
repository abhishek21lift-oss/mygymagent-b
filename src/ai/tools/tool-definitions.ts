/**
 * The explicit, named tool allowlist the AI is permitted to call --
 * see docs/ai/architecture.md's "§56 -- Explicit tool allowlist" section.
 * There is no generic query/database-access tool, and there never should
 * be: every tool here is narrow, single-purpose, and its executor
 * (tool-executor.service.ts) calls the exact same organizationId-scoped
 * domain service the REST API uses -- the AI layer gets no special-cased
 * data-access path that bypasses RBAC/tenant scoping.
 */
export const AI_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_member',
      description:
        "Look up a gym member's operational profile (name, status, branch, trainer, recent memberships). Does not return PII like email/phone/address.",
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: 'The member id' },
        },
        required: ['memberId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_workout_history',
      description:
        "List a member's assigned workout plans and their status (active/completed/cancelled).",
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: 'The member id' },
        },
        required: ['memberId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_attendance',
      description:
        "Summarize a member's recent gym visits: total check-ins in the last 30 days and the 5 most recent check-in dates. Not a raw attendance-log dump.",
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: 'The member id' },
        },
        required: ['memberId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_workout_draft',
      description:
        "Create a new workout plan (a draft, not assigned to anyone automatically) from a list of exercises. Every exerciseId must be one already in this organization's exercise library -- look it up first if unsure, or ask the user which exercises to use.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plan name' },
          description: {
            type: 'string',
            description: 'Optional plan description',
          },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                exerciseId: { type: 'string' },
                order: { type: 'number' },
                sets: { type: 'number' },
                reps: { type: 'string', description: 'e.g. "8-12" or "AMRAP"' },
                restSeconds: { type: 'number' },
                notes: { type: 'string' },
              },
              required: ['exerciseId', 'order', 'sets', 'reps'],
            },
          },
        },
        required: ['name', 'exercises'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_diet_draft',
      description:
        "Create a new diet plan (a draft, not assigned to anyone automatically) from a list of food items. Every foodItemId must be one already in this organization's food library -- look it up first if unsure, or ask the user which foods to use.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plan name' },
          description: {
            type: 'string',
            description: 'Optional plan description',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                foodItemId: { type: 'string' },
                mealSlot: {
                  type: 'string',
                  enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'],
                },
                quantity: { type: 'number' },
                unit: {
                  type: 'string',
                  description: 'e.g. "g", "cup", "piece"',
                },
                notes: { type: 'string' },
              },
              required: ['foodItemId', 'mealSlot', 'quantity', 'unit'],
            },
          },
          targetCalories: { type: 'number' },
        },
        required: ['name', 'items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_followup',
      description: 'Schedule a follow-up task against a CRM lead.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'The lead id' },
          note: { type: 'string', description: 'What to do' },
          dueAt: {
            type: 'string',
            description: 'ISO 8601 date/time the follow-up is due',
          },
        },
        required: ['leadId', 'note', 'dueAt'],
      },
    },
  },
] as const;

export type AiToolName =
  (typeof AI_TOOL_DEFINITIONS)[number]['function']['name'];
