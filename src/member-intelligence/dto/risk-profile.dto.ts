import { RiskLevel, RiskTrend } from '@prisma/client';

export class RiskProfileResponseDto {
  memberId: string;
  overallScore: number;
  riskLevel: RiskLevel;
  trend: RiskTrend;
  contributingFactors: ContributingFactorDto[];
  protectiveFactors: string[];
  computedAt: Date;
}

export class ContributingFactorDto {
  factor: string;
  weight: number;
  rawValue: number;
  normalizedValue: number;
  contribution: number;
  threshold: number;
  direction: 'NEGATIVE' | 'POSITIVE';
  explanation: string;
}

export class MemberIntelligenceResponseDto {
  memberId: string;
  riskProfile: RiskProfileResponseDto | null;
  attendanceVelocity: number;
  paymentReliability: number;
  engagementScore: number;
  membershipStatus: string;
  daysUntilExpiry: number | null;
}

export class BatchComputeResponseDto {
  processed: number;
  errors: number;
  organizationId: string;
  branchScope: string | null;
}
