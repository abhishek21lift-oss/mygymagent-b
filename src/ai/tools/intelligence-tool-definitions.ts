import { AI_TOOL_DEFINITIONS as BASE_TOOL_DEFINITIONS } from './tool-definitions';

const WORKOUT_PROGRESS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'analyze_workout_progress',
    description:
      "Analyze a member's recorded exercise history for one exercise. Returns only evidence-backed progression signals from real completed sets: trend, best recorded set, recent-vs-earlier comparison, and data sufficiency. It does not invent a prediction or modify a workout.",
    parameters: {
      type: 'object',
      properties: {
        memberId: { type: 'string', description: 'The member id' },
        exerciseId: { type: 'string', description: 'The exercise id' },
        limit: {
          type: 'integer',
          minimum: 5,
          maximum: 100,
          description: 'Maximum recorded sets to analyze; defaults to 50',
        },
      },
      required: ['memberId', 'exerciseId'],
    },
  },
} as const;

export const AI_TOOL_DEFINITIONS = [
  ...BASE_TOOL_DEFINITIONS,
  WORKOUT_PROGRESS_TOOL,
] as const;

export type AiToolName =
  (typeof AI_TOOL_DEFINITIONS)[number]['function']['name'];

export type BaseAiToolName =
  (typeof BASE_TOOL_DEFINITIONS)[number]['function']['name'];
