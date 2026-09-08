import { Injectable } from '@nestjs/common';
import type { Lead, LeadFollowUp } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/**
 * Deterministic, explainable lead scoring computed from real Lead and
 * LeadFollowUp rows. No hidden model, no persisted score column -- the
 * grade can always be re-derived and every point is attributable to a
 * visible factor. Aligned with docs/ai/architecture.md's LeadScoreSchema
 * philosophy: analytics data is computed, not guessed.
 */

export interface LeadScoreFactor {
  label: string;
  points: number;
}

export interface LeadScore {
  leadId: string;
  score: number;
  grade: 'HOT' | 'WARM' | 'COLD';
  factors: LeadScoreFactor[];
}

const STATUS_WEIGHTS: Record<string, number> = {
  NEW: 5,
  CONTACTED: 15,
  QUALIFIED: 40,
  TRIAL: 55,
  PROPOSAL: 70,
  WON: 100,
  LOST: 0,
};

const GRADE_THRESHOLDS = { HOT: 70, WARM: 40 } as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 30;
const COMPLETED_FOLLOWUP_POINTS = 5;
const COMPLETED_FOLLOWUP_CAP = 15;

type ScoredLead = Lead & {
  followUps?: LeadFollowUp[];
  _count?: { followUps?: number };
};

@Injectable()
export class LeadScoringService {
  /** Score a single lead with its follow-ups already loaded. */
  score(lead: ScoredLead, now: Date = new Date()): LeadScore {
    const factors: LeadScoreFactor[] = [];

    const statusWeight = STATUS_WEIGHTS[lead.status] ?? 0;
    factors.push({
      label: `Pipeline stage ${lead.status}`,
      points: statusWeight,
    });

    if (lead.email) {
      factors.push({ label: 'Email on file', points: 10 });
    }
    if (lead.phone) {
      factors.push({ label: 'Phone on file', points: 10 });
    }

    const source = lead.source?.trim().toLowerCase() ?? '';
    if (source === 'referral' || source === 'member referral') {
      factors.push({ label: 'Referral source', points: 15 });
    }

    const completedFollowUps = (lead.followUps ?? []).filter(
      (f) => f.completedAt !== null,
    ).length;
    if (completedFollowUps > 0) {
      factors.push({
        label: `${completedFollowUps} completed follow-up(s)`,
        points: Math.min(
          completedFollowUps * COMPLETED_FOLLOWUP_POINTS,
          COMPLETED_FOLLOWUP_CAP,
        ),
      });
    }

    if (lead.assignedToUserId) {
      factors.push({ label: 'Assigned to a rep', points: 5 });
    }

    const ageDays = (now.getTime() - lead.createdAt.getTime()) / MS_PER_DAY;
    if (ageDays > RECENT_WINDOW_DAYS && lead.status !== 'WON') {
      factors.push({
        label: 'Older than 30 days without conversion',
        points: -10,
      });
    }

    const score = Math.max(
      0,
      Math.min(
        100,
        factors.reduce((sum, f) => sum + f.points, 0),
      ),
    );

    return {
      leadId: lead.id,
      score,
      grade: this.grade(score),
      factors,
    };
  }

  /** Batch-score leads for list views without extra queries. */
  scoreMany(
    leads: ScoredLead[],
    now: Date = new Date(),
  ): Map<string, LeadScore> {
    return new Map(leads.map((lead) => [lead.id, this.score(lead, now)]));
  }

  private grade(score: number): LeadScore['grade'] {
    if (score >= GRADE_THRESHOLDS.HOT) return 'HOT';
    if (score >= GRADE_THRESHOLDS.WARM) return 'WARM';
    return 'COLD';
  }
}

/** Prisma include used by callers that plan to score the fetched leads. */
export const LEAD_SCORE_INCLUDE: Prisma.LeadInclude = {
  followUps: { select: { completedAt: true } },
};
