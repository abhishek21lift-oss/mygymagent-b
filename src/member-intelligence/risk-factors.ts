export interface RiskFactorConfig {
  factor: string;
  description: string;
  weight: number;
  thresholds: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  direction: 'NEGATIVE' | 'POSITIVE';
}

export const RISK_FACTORS: Record<string, RiskFactorConfig> = {
  ATTENDANCE_DECLINE: {
    factor: 'ATTENDANCE_DECLINE',
    description: 'Attendance decline compared to previous period',
    weight: 25,
    thresholds: { low: 0.1, medium: 0.3, high: 0.5, critical: 0.7 },
    direction: 'NEGATIVE',
  },
  PAYMENT_RELIABILITY: {
    factor: 'PAYMENT_RELIABILITY',
    description: 'Payment history and outstanding balance',
    weight: 30,
    thresholds: { low: 0, medium: 1, high: 2, critical: 3 },
    direction: 'NEGATIVE',
  },
  ENGAGEMENT_DROP: {
    factor: 'ENGAGEMENT_DROP',
    description: 'Days since last workout or plan activity',
    weight: 20,
    thresholds: { low: 7, medium: 14, high: 21, critical: 30 },
    direction: 'NEGATIVE',
  },
  GOAL_STAGNATION: {
    factor: 'GOAL_STAGNATION',
    description: 'Overdue goal milestones',
    weight: 15,
    thresholds: { low: 0, medium: 3, high: 7, critical: 14 },
    direction: 'NEGATIVE',
  },
  NEW_MEMBER_RISK: {
    factor: 'NEW_MEMBER_RISK',
    description: 'Early tenure risk (first 90 days)',
    weight: 10,
    thresholds: { low: 90, medium: 60, high: 30, critical: 14 },
    direction: 'POSITIVE',
  },
  RENEWAL_PROXIMITY: {
    factor: 'RENEWAL_PROXIMITY',
    description: 'Days until membership expiry',
    weight: 15,
    thresholds: { low: 30, medium: 14, high: 7, critical: 3 },
    direction: 'NEGATIVE',
  },
  TAG_RISK_SIGNALS: {
    factor: 'TAG_RISK_SIGNALS',
    description: 'Negative tags (complaint, churned, etc.)',
    weight: 10,
    thresholds: { low: 0, medium: 1, high: 2, critical: 3 },
    direction: 'NEGATIVE',
  },
  MEMBER_TENURE: {
    factor: 'MEMBER_TENURE',
    description: 'Length of membership (protective factor)',
    weight: -10,
    thresholds: { low: 365, medium: 180, high: 90, critical: 30 },
    direction: 'POSITIVE',
  },
};

export interface RiskFactorInput {
  memberId: string;
  attendanceLast30Days: number;
  attendancePrevious30Days: number;
  daysSinceLastAttendance: number;
  outstandingBalance: number;
  latePaymentCount: number;
  daysSinceLastWorkout: number;
  overdueMilestones: number;
  daysSinceJoining: number;
  daysUntilExpiry: number | null;
  negativeTagCount: number;
  memberTenureDays: number;
  hasActiveGoals: boolean;
}

export interface RiskFactorResult {
  factor: string;
  weight: number;
  rawValue: number;
  normalizedValue: number;
  contribution: number;
  threshold: number;
  direction: 'NEGATIVE' | 'POSITIVE';
  explanation: string;
}

export function computeFactorScore(
  config: RiskFactorConfig,
  input: number,
  _isDirectionPositive: boolean,
): { score: number; threshold: number; explanation: string } {
  const { thresholds, weight, description, direction } = config;
  let normalizedValue: number;
  let threshold: number;

  if (direction === 'NEGATIVE') {
    if (input <= thresholds.low) {
      normalizedValue = 0;
      threshold = thresholds.low;
    } else if (input <= thresholds.medium) {
      normalizedValue = 25;
      threshold = thresholds.medium;
    } else if (input <= thresholds.high) {
      normalizedValue = 50;
      threshold = thresholds.high;
    } else if (input <= thresholds.critical) {
      normalizedValue = 75;
      threshold = thresholds.critical;
    } else {
      normalizedValue = 100;
      threshold = thresholds.critical;
    }
  } else {
    if (input >= thresholds.low) {
      normalizedValue = 0;
      threshold = thresholds.low;
    } else if (input >= thresholds.medium) {
      normalizedValue = 25;
      threshold = thresholds.medium;
    } else if (input >= thresholds.high) {
      normalizedValue = 50;
      threshold = thresholds.high;
    } else if (input >= thresholds.critical) {
      normalizedValue = 75;
      threshold = thresholds.critical;
    } else {
      normalizedValue = 100;
      threshold = thresholds.critical;
    }
  }

  const contribution = (normalizedValue / 100) * weight;
  const explanation = `${description}: ${input} ${direction === 'NEGATIVE' ? 'triggers' : 'protects against'} risk at ${normalizedValue}% severity`;

  return { score: contribution, threshold, explanation };
}

export function getRiskLevel(
  score: number,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (score < 20) return 'LOW';
  if (score < 45) return 'MEDIUM';
  if (score < 70) return 'HIGH';
  return 'CRITICAL';
}
