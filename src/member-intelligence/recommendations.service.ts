import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActionType,
  Priority,
  ChannelType,
  ActionStatus,
  RecommendedAction,
} from '@prisma/client';
import { ChurnEngineService } from './churn-engine.service';
import { RiskEngineService } from './risk-engine.service';

export interface ActionRecommendation {
  type: ActionType;
  priority: Priority;
  confidence: number;
  reasoning: string;
  suggestedChannel: ChannelType | null;
  suggestedContent: string | null;
  suggestedOfferType: string | null;
  discountPercent: number | null;
  freezeDays: number | null;
  automatable: boolean;
}

@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly churnEngine: ChurnEngineService,
    private readonly riskEngine: RiskEngineService,
  ) {}

  async generateRecommendations(
    organizationId: string,
    memberId: string,
  ): Promise<ActionRecommendation[]> {
    const churnAssessment = await this.churnEngine.assessMemberChurn(
      organizationId,
      memberId,
    );
    const riskProfile = await this.riskEngine.getMemberIntelligence(
      organizationId,
      memberId,
    );

    if (!churnAssessment) return [];

    const recommendations: ActionRecommendation[] = [];

    if (churnAssessment.isAtRisk && churnAssessment.retentionOpportunity) {
      const trigger = churnAssessment.retentionOpportunity.trigger;

      switch (trigger) {
        case 'SAVEABLE':
          recommendations.push({
            type: 'OUTREACH_CHURN_RISK',
            priority: 'P0',
            confidence: 0.85,
            reasoning:
              'High risk but still engaged. Personal outreach has highest success probability.',
            suggestedChannel: 'CALL',
            suggestedContent: `Hi {{member.firstName}}, I noticed you've been busy lately. Would love to catch up and see how we can keep you on track with your goals. Can we schedule a quick chat?`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: false,
          });
          recommendations.push({
            type: 'ASSESSMENT_BOOK',
            priority: 'P1',
            confidence: 0.75,
            reasoning:
              'Fresh assessment helps re-engage and identify new goals.',
            suggestedChannel: 'WHATSAPP',
            suggestedContent: `Hey {{member.firstName}}! We've got some great new equipment and would love to show you. Free assessment session this week - interested?`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: true,
          });
          break;

        case 'DISCOUNT_CANDIDATE':
          if (
            churnAssessment.churnIndicators.some(
              (i) => i.indicator === 'PAYMENT_FAILED_AT_RISK',
            )
          ) {
            recommendations.push({
              type: 'PAYMENT_PLAN',
              priority: 'P0',
              confidence: 0.9,
              reasoning:
                'Payment failure detected. Offering payment plan prevents immediate churn.',
              suggestedChannel: 'CALL',
              suggestedContent: `Hi {{member.firstName}}, let's figure out a payment solution that works for you. We can spread payments over a few months.`,
              suggestedOfferType: 'PAYMENT_PLAN',
              discountPercent: null,
              freezeDays: null,
              automatable: false,
            });
          } else {
            recommendations.push({
              type: 'FREEZE_OFFER',
              priority: 'P1',
              confidence: 0.7,
              reasoning:
                'At renewal with hesitation signals. Freeze offer removes pressure.',
              suggestedChannel: 'EMAIL',
              suggestedContent: `Hi {{member.firstName}}, your membership is coming up for renewal. If life has been hectic, we can freeze your account for up to 3 months - no hassle. Would that help?`,
              suggestedOfferType: 'FREEZE',
              discountPercent: null,
              freezeDays: 90,
              automatable: true,
            });
            recommendations.push({
              type: 'RENEWAL_NUDGE',
              priority: 'P1',
              confidence: 0.7,
              reasoning: 'Renewal window with price-sensitive signals.',
              suggestedChannel: 'WHATSAPP',
              suggestedContent: `Hi {{member.firstName}}! Your membership renews soon. Lock in your current rate - we can extend it for 12 months at today's price.`,
              suggestedOfferType: null,
              discountPercent: 10,
              freezeDays: null,
              automatable: true,
            });
          }
          break;

        case 'RE_ENGAGEMENT':
          recommendations.push({
            type: 'RE_ENGAGEMENT',
            priority: 'P1',
            confidence: 0.7,
            reasoning:
              'Lapsed engagement - re-engagement campaign has best ROI.',
            suggestedChannel: 'WHATSAPP',
            suggestedContent: `Hi {{member.firstName}}, we miss you! Here's a special re-engagement offer: 2 weeks free training on us. No commitment needed.`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: true,
          });
          recommendations.push({
            type: 'UPGRADE_PITCH',
            priority: 'P2',
            confidence: 0.6,
            reasoning: 'New workout variety can re-spark engagement.',
            suggestedChannel: 'EMAIL',
            suggestedContent: `Hi {{member.firstName}}, we've added PT sessions and nutrition coaching. Want to try a complimentary session?`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: true,
          });
          break;

        case 'CHAMPION':
          recommendations.push({
            type: 'LOYALTY_REWARD',
            priority: 'P2',
            confidence: 0.8,
            reasoning:
              'Champion member at risk of complacency. Appreciation prevents drift.',
            suggestedChannel: 'WHATSAPP',
            suggestedContent: `Hi {{member.firstName}}! You've been with us for a while and we really appreciate it. As a thank you, here's an exclusive upgrade offer...`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: true,
          });
          recommendations.push({
            type: 'UPGRADE_PITCH',
            priority: 'P2',
            confidence: 0.65,
            reasoning: 'Long-term member - prime for premium upsell.',
            suggestedChannel: 'CALL',
            suggestedContent: `Hi {{member.firstName}}, as one of our longest members, I'd love to chat about our premium offerings. You deserve the best.`,
            suggestedOfferType: null,
            discountPercent: null,
            freezeDays: null,
            automatable: false,
          });
          break;
      }
    }

    if (
      riskProfile?.riskProfile?.contributingFactors.some(
        (f) => f.factor === 'GOAL_STAGNATION',
      )
    ) {
      recommendations.push({
        type: 'ASSESSMENT_BOOK',
        priority: 'P1',
        confidence: 0.75,
        reasoning:
          'Goal stagnation detected - assessment can help reset direction.',
        suggestedChannel: 'WHATSAPP',
        suggestedContent: `Hi {{member.firstName}}, how are your goals going? Let's do a quick check-in and see if we can adjust your plan.`,
        suggestedOfferType: null,
        discountPercent: null,
        freezeDays: null,
        automatable: true,
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { P0: 0, P1: 1, P2: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  async createRecommendations(
    organizationId: string,
    memberId: string,
    recommendations: ActionRecommendation[],
  ): Promise<RecommendedAction[]> {
    const existing = await this.prisma.recommendedAction.findMany({
      where: { organizationId, memberId, status: 'PENDING' },
    });

    for (const rec of existing) {
      await this.prisma.recommendedAction.update({
        where: { id: rec.id },
        data: { status: 'DISMISSED' },
      });
    }

    const created: RecommendedAction[] = [];
    for (const rec of recommendations) {
      const action = await this.prisma.recommendedAction.create({
        data: {
          organizationId,
          memberId,
          type: rec.type,
          priority: rec.priority,
          confidence: rec.confidence,
          reasoning: rec.reasoning,
          suggestedChannel: rec.suggestedChannel,
          suggestedContent: rec.suggestedContent,
          suggestedOfferType: rec.suggestedOfferType,
          discountPercent: rec.discountPercent,
          freezeDays: rec.freezeDays,
          status: rec.automatable ? 'AUTOMATED' : 'PENDING',
        },
      });
      created.push(action);
    }

    return created;
  }

  async getRecommendations(
    organizationId: string,
    memberId: string,
    status?: ActionStatus,
  ): Promise<RecommendedAction[]> {
    return this.prisma.recommendedAction.findMany({
      where: {
        organizationId,
        memberId,
        ...(status ? { status } : {}),
      },
      orderBy: [
        { priority: 'asc' },
        { confidence: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  async executeRecommendation(
    organizationId: string,
    actionId: string,
    userId: string,
  ): Promise<RecommendedAction> {
    return this.prisma.recommendedAction.update({
      where: { id: actionId, organizationId },
      data: {
        status: 'COMPLETED',
        assignedToUserId: userId,
        completedAt: new Date(),
      },
    });
  }

  async dismissRecommendation(
    organizationId: string,
    actionId: string,
  ): Promise<RecommendedAction> {
    return this.prisma.recommendedAction.update({
      where: { id: actionId, organizationId },
      data: { status: 'DISMISSED' },
    });
  }
}
