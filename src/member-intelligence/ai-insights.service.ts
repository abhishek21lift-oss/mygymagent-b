import { Injectable } from '@nestjs/common';
import { OpenRouterProvider } from '../ai/providers/openrouter.provider';
import { RiskEngineService } from './risk-engine.service';
import { ChurnEngineService } from './churn-engine.service';
import { IntelligenceAnalyticsService } from './intelligence-analytics.service';

export interface MemberInsight {
  memberId: string;
  insightType:
    | 'RISK_SUMMARY'
    | 'CHURN_REASON'
    | 'ENGAGEMENT_PATTERN'
    | 'RETENTION_STRATEGY';
  summary: string;
  detail: string;
  confidence: number;
  generatedAt: Date;
}

export interface SegmentInsight {
  segmentName: string;
  insightType: 'COHORT_ANALYSIS' | 'RISK_DISTRIBUTION' | 'CHURN_PATTERNS';
  summary: string;
  detail: string;
  memberCount: number;
  generatedAt: Date;
}

const SYSTEM_PROMPT = `You are a gym member intelligence analyst. Analyze member data and provide clear, actionable insights.

For each insight you provide:
1. Start with the key takeaway (what matters most)
2. Explain the reasoning (what data drove this)
3. Suggest one specific action (what to do next)

Be direct and specific. Avoid vague language like "may want to consider".`;

@Injectable()
export class AiInsightsService {
  constructor(
    private readonly openRouter: OpenRouterProvider,
    private readonly riskEngine: RiskEngineService,
    private readonly churnEngine: ChurnEngineService,
    private readonly analytics: IntelligenceAnalyticsService,
  ) {}

  async generateMemberInsight(
    organizationId: string,
    memberId: string,
  ): Promise<MemberInsight | null> {
    const [riskProfile, churnAssessment] = await Promise.all([
      this.riskEngine.getMemberIntelligence(organizationId, memberId),
      this.churnEngine.assessMemberChurn(organizationId, memberId),
    ]);

    if (!riskProfile) return null;

    const riskLevel = riskProfile.riskProfile?.riskLevel ?? 'LOW';
    const riskScore = riskProfile.riskProfile?.overallScore ?? 0;
    const churnProbability = churnAssessment?.churnProbability ?? 0;
    const contributingFactors =
      riskProfile.riskProfile?.contributingFactors ?? [];
    const trend = riskProfile.riskProfile?.trend ?? 'STABLE';

    const factorsList = contributingFactors
      .slice(0, 3)
      .map((f) => `- ${f.explanation}`)
      .join('\n');

    const userMessage = `Analyze this member's data and provide a risk summary:

Member ID: ${memberId}
Risk Level: ${riskLevel} (score: ${riskScore}/100)
Trend: ${trend}
Churn Probability: ${(churnProbability * 100).toFixed(0)}%
Engagement Score: ${(riskProfile.engagementScore * 100).toFixed(0)}%
Attendance Velocity: ${(riskProfile.attendanceVelocity * 7).toFixed(1)} visits/week
Payment Reliability: ${(riskProfile.paymentReliability * 100).toFixed(0)}%
Membership Status: ${riskProfile.membershipStatus}
Days Until Expiry: ${riskProfile.daysUntilExpiry ?? 'N/A'}

Top Contributing Factors:
${factorsList || 'No significant risk factors identified'}

Provide a RISK_SUMMARY insight in this format:
SUMMARY: [1-2 sentence key takeaway]
DETAIL: [3-4 sentence explanation of risk factors and their impact]
CONFIDENCE: [0.0-1.0 based on data completeness]`;

    try {
      const completion = await this.openRouter.chatCompletion([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ]);

      const content = completion.message.content ?? '';
      const insight = this.parseMemberInsight(
        content,
        memberId,
        'RISK_SUMMARY',
      );
      return insight;
    } catch {
      return this.generateFallbackInsight(
        memberId,
        riskLevel,
        riskScore,
        trend,
      );
    }
  }

  async generateChurnReason(
    organizationId: string,
    memberId: string,
  ): Promise<MemberInsight | null> {
    const churnAssessment = await this.churnEngine.assessMemberChurn(
      organizationId,
      memberId,
    );

    if (!churnAssessment || !churnAssessment.isAtRisk) return null;

    const indicators = churnAssessment.churnIndicators
      .map((i) => `- ${i.indicator}: ${i.description} (${i.severity})`)
      .join('\n');

    const retention = churnAssessment.retentionOpportunity;

    const userMessage = `Analyze why this member is at risk of churning:

Member ID: ${memberId}
Churn Probability: ${(churnAssessment.churnProbability * 100).toFixed(0)}%
Is At Risk: ${churnAssessment.isAtRisk}

Churn Indicators:
${indicators || 'No specific indicators detected'}

Retention Opportunity:
- Trigger: ${retention?.trigger ?? 'N/A'}
- Priority: ${retention?.priority ?? 'N/A'}
- Description: ${retention?.description ?? 'N/A'}

Recommended Actions:
${retention?.recommendedActions.join('\n') ?? 'None'}

Provide a CHURN_REASON insight in this format:
SUMMARY: [1-2 sentence explanation of why this member is at risk]
DETAIL: [3-4 sentence analysis of the specific factors and timing]
CONFIDENCE: [0.0-1.0 based on indicator specificity]`;

    try {
      const completion = await this.openRouter.chatCompletion([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ]);

      const content = completion.message.content ?? '';
      const insight = this.parseMemberInsight(
        content,
        memberId,
        'CHURN_REASON',
      );
      return insight;
    } catch {
      const indicator = churnAssessment.churnIndicators[0];
      return {
        memberId,
        insightType: 'CHURN_REASON',
        summary: `Member at ${(churnAssessment.churnProbability * 100).toFixed(0)}% churn probability due to ${indicator?.indicator ?? 'unknown factors'}`,
        detail: indicator?.description ?? 'Multiple risk factors detected',
        confidence: 0.7,
        generatedAt: new Date(),
      };
    }
  }

  async generateSegmentInsight(
    organizationId: string,
    segmentName: string,
    memberIds: string[],
  ): Promise<SegmentInsight | null> {
    const riskOverview = await this.analytics.getRiskOverview(organizationId);
    const revenueAtRisk = await this.analytics.getRevenueAtRisk(organizationId);

    const highRiskCount =
      riskOverview.riskDistribution.find((r) => r.riskLevel === 'HIGH')
        ?.count ?? 0;
    const criticalRiskCount =
      riskOverview.riskDistribution.find((r) => r.riskLevel === 'CRITICAL')
        ?.count ?? 0;
    const totalAtRisk = highRiskCount + criticalRiskCount;

    const userMessage = `Analyze this member segment:

Segment: ${segmentName}
Member Count: ${memberIds.length}
Organization Risk Overview:
- Total Members: ${riskOverview.totalMembers}
- HIGH Risk: ${highRiskCount} (${((highRiskCount / riskOverview.totalMembers) * 100).toFixed(1)}%)
- CRITICAL Risk: ${criticalRiskCount} (${((criticalRiskCount / riskOverview.totalMembers) * 100).toFixed(1)}%)
- Revenue at Risk: $${revenueAtRisk.atRiskMRR.toFixed(2)}/month

Provide a RISK_DISTRIBUTION insight in this format:
SUMMARY: [1-2 sentence key takeaway about this segment's risk profile]
DETAIL: [3-4 sentence analysis comparing this segment to org averages]
MEMBER_COUNT: [the member count provided above]`;

    try {
      const completion = await this.openRouter.chatCompletion([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ]);

      const content = completion.message.content ?? '';
      return this.parseSegmentInsight(
        content,
        segmentName,
        memberIds.length,
        'RISK_DISTRIBUTION',
      );
    } catch {
      return {
        segmentName,
        insightType: 'RISK_DISTRIBUTION',
        summary: `${totalAtRisk} members (${((totalAtRisk / riskOverview.totalMembers) * 100).toFixed(1)}%) in HIGH/CRITICAL risk`,
        detail: `Segment represents $${revenueAtRisk.atRiskMRR.toFixed(2)}/month in at-risk revenue`,
        memberCount: memberIds.length,
        generatedAt: new Date(),
      };
    }
  }

  private parseMemberInsight(
    content: string,
    memberId: string,
    insightType: MemberInsight['insightType'],
  ): MemberInsight {
    const summaryMatch = content.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
    const detailMatch = content.match(/DETAIL:\s*(.+?)(?:\n|$)/i);
    const confidenceMatch = content.match(/CONFIDENCE:\s*([\d.]+)/i);

    return {
      memberId,
      insightType,
      summary:
        summaryMatch?.[1]?.trim() ?? 'Risk analysis completed for this member',
      detail:
        detailMatch?.[1]?.trim() ??
        'Detailed analysis available in member intelligence dashboard',
      confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.75,
      generatedAt: new Date(),
    };
  }

  private parseSegmentInsight(
    content: string,
    segmentName: string,
    memberCount: number,
    insightType: SegmentInsight['insightType'],
  ): SegmentInsight {
    const summaryMatch = content.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
    const detailMatch = content.match(/DETAIL:\s*(.+?)(?:\n|$)/i);
    const countMatch = content.match(/MEMBER_COUNT:\s*(\d+)/i);

    return {
      segmentName,
      insightType,
      summary: summaryMatch?.[1]?.trim() ?? 'Segment risk analysis completed',
      detail:
        detailMatch?.[1]?.trim() ??
        'Detailed analysis available in analytics dashboard',
      memberCount: countMatch ? parseInt(countMatch[1], 10) : memberCount,
      generatedAt: new Date(),
    };
  }

  private generateFallbackInsight(
    memberId: string,
    riskLevel: string,
    riskScore: number,
    trend: string,
  ): MemberInsight {
    return {
      memberId,
      insightType: 'RISK_SUMMARY',
      summary: `Member is at ${riskLevel} risk with a score of ${riskScore}/100, trend is ${trend}`,
      detail:
        'AI-generated insight unavailable. Review member dashboard for detailed risk factors.',
      confidence: 0.5,
      generatedAt: new Date(),
    };
  }
}
