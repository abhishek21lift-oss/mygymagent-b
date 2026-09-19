export type SegmentOperator =
  'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

export interface SegmentRule {
  field: string;
  operator: SegmentOperator;
  value: string | number | boolean | string[] | number[];
  logicalOp?: 'AND' | 'OR';
}

export interface SegmentField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  enumValues?: string[];
}

export const SEGMENT_FIELDS: SegmentField[] = [
  {
    name: 'status',
    label: 'Member Status',
    type: 'enum',
    enumValues: ['ACTIVE', 'INACTIVE', 'FROZEN', 'EXPIRED'],
  },
  {
    name: 'memberType',
    label: 'Member Type',
    type: 'enum',
    enumValues: ['GYM', 'PT', 'GYM_PT'],
  },
  {
    name: 'gender',
    label: 'Gender',
    type: 'enum',
    enumValues: ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'],
  },
  {
    name: 'riskLevel',
    label: 'Risk Level',
    type: 'enum',
    enumValues: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  },
  {
    name: 'daysSinceLastVisit',
    label: 'Days Since Last Visit',
    type: 'number',
  },
  { name: 'daysSinceJoining', label: 'Days Since Joining', type: 'number' },
  { name: 'daysUntilExpiry', label: 'Days Until Expiry', type: 'number' },
  { name: 'totalPayments', label: 'Total Payments', type: 'number' },
  {
    name: 'attendanceLast30Days',
    label: 'Attendance (30 days)',
    type: 'number',
  },
  { name: 'hasGoals', label: 'Has Active Goals', type: 'boolean' },
  { name: 'hasTrainer', label: 'Has Assigned Trainer', type: 'boolean' },
  {
    name: 'membershipStatus',
    label: 'Membership Status',
    type: 'enum',
    enumValues: ['ACTIVE', 'PENDING', 'FROZEN', 'EXPIRED', 'CANCELLED'],
  },
  { name: 'primaryBranchId', label: 'Primary Branch', type: 'string' },
  { name: 'assignedTrainerId', label: 'Assigned Trainer', type: 'string' },
];

export interface MemberSegmentResult {
  memberId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: string;
  riskLevel: string | null;
}

export function evaluateRule(
  member: Record<string, any>,
  rule: SegmentRule,
): boolean {
  const fieldValue = member[rule.field];
  const { operator, value } = rule;

  switch (operator) {
    case 'eq':
      return fieldValue === value;
    case 'ne':
      return fieldValue !== value;
    case 'gt':
      return (
        typeof fieldValue === 'number' &&
        typeof value === 'number' &&
        fieldValue > value
      );
    case 'gte':
      return (
        typeof fieldValue === 'number' &&
        typeof value === 'number' &&
        fieldValue >= value
      );
    case 'lt':
      return (
        typeof fieldValue === 'number' &&
        typeof value === 'number' &&
        fieldValue < value
      );
    case 'lte':
      return (
        typeof fieldValue === 'number' &&
        typeof value === 'number' &&
        fieldValue <= value
      );
    case 'in':
      return Array.isArray(value) && (value as any[]).includes(fieldValue);
    case 'contains':
      return (
        typeof fieldValue === 'string' &&
        typeof value === 'string' &&
        fieldValue.includes(value)
      );
    default:
      return false;
  }
}

export function evaluateRules(
  member: Record<string, any>,
  rules: SegmentRule[],
): boolean {
  if (rules.length === 0) return true;

  let result = evaluateRule(member, rules[0]);

  for (let i = 1; i < rules.length; i++) {
    const rule = rules[i];
    const ruleResult = evaluateRule(member, rule);
    const logicalOp = rule.logicalOp ?? 'AND';

    if (logicalOp === 'AND') {
      result = result && ruleResult;
    } else {
      result = result || ruleResult;
    }
  }

  return result;
}
