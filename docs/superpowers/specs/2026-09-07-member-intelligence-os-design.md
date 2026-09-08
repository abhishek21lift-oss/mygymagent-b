# Member Intelligence OS — Design Specification

## Context

Gym management platforms collect rich member data — attendance, payments, workouts, goals, assessments — but this data remains underutilized. Staff make gut-feel decisions about churn risk, upsell timing, and engagement. Members receive generic communications instead of personalized interventions.

**Goal**: Build a production-grade Member Intelligence OS that transforms raw member data into explainable risk scores, churn predictions, retention insights, AI-generated recommendations, automated actions, and smart segmentation — all fully integrated with the existing Member OS, multi-tenant, and performant.

## What Exists Today

| Component | State |
|-----------|-------|
| Member 360 | ✅ Built — member profile, timeline, documents, tags |
| Attendance tracking | ✅ Built — check-in/out, frequency |
| Payment/Membership | ✅ Built — renewal, freeze, expiry |
| Analytics → MemberIntelligenceService | ⚠️ Partial — `getAtRiskMembers()` (14+ day inactive), `getStatusBreakdown()` |
| AI chat + analytics tools | ⚠️ Partial — 5 analytics tools exposed, no recommendations |
| Automation | ⚠️ Partial — 5 rule-based automations, notification-only |
| Member segmentation | ❌ Not built — no dynamic segments |
| Churn/Retention engine | ❌ Not built — no risk scoring, no ML |
| AI Recommendations | ❌ Not built — no explainable action recommendations |

## What We're Building

### Phase 1: Risk Engine
Multi-factor risk scoring model that produces an **explainable risk score (0-100)** per member with contributing factors.

**Risk Factors:**
- Attendance decline (last 30d vs previous 30d)
- Payment delinquency (outstanding balance, late payments)
- Engagement drop (no workouts/diet plans in 14d)
- Goal stagnation (milestones overdue)
- Membership tenure (new members in first 90d = higher risk)
- Membership proximity to expiry (7d/30d windows)
- Tag-based risk signals (e.g., "complaint" tag)

**Output:**
```typescript
interface MemberRiskProfile {
  memberId: string;
  overallScore: number;           // 0-100 (higher = more at risk)
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  contributingFactors: RiskFactor[];
  protectiveFactors: string[];     // what's keeping score lower
  trend: 'IMPROVING' | 'STABLE' | 'WORSENING';
  computedAt: Date;
}

interface RiskFactor {
  factor: string;          // e.g., "ATTENDANCE_DECLINE"
  weight: number;         // contribution to overall score
  value: number;           // raw metric value
  threshold: number;       // when this factor triggers
  direction: 'NEGATIVE' | 'POSITIVE';
  explanation: string;    // human-readable
}
```

### Phase 2: Analytics Engine
Real-time aggregation layer that feeds the Risk Engine and powers dashboards.

**Metrics computed per member:**
- Attendance velocity (check-ins per week, trend)
- Payment reliability (on-time %, outstanding balance)
- Engagement score (workout frequency, goal progress, assessment completion)
- Tenure-adjusted risk windows
- Revenue at risk (monthly revenue per at-risk member)

**Aggregate views:**
- Organization-level churn risk distribution
- Branch-level risk breakdown
- Cohort analysis (join month → risk over time)
- Revenue at risk dashboard

### Phase 3: Churn & Retention Engine
Processes Risk Engine output into actionable churn insights.

**Churn indicators:**
- Risk score > 70 for 14+ consecutive days
- Payment failed + no engagement for 7d
- Membership expired + no renewal intent signal
- Attendance: 0 in 30d for previously active member

**Retention triggers:**
- "Saveable" — high risk but still engaged (attendances in last 7d)
- "Discount candidate" — at renewal window, showing hesitation signals
- "Re-engagement" — lapsed 14-30d, no automated contact in 7d
- "Champion" — highly engaged, long tenure, at-risk of complacency

### Phase 4: AI Insights Layer
Explainable AI that generates natural language insights per member and cohort.

**Insight types:**
- "Member X is at HIGH risk (score: 78) because attendance dropped 60% this month and their membership renews in 5 days with no payment recorded."
- "Segment 'Lapsed 30-Day Members' has 43 members with combined MRR of $12,400 at risk."
- "Branch 'Downtown' has 23% more at-risk members than org average. Top factor: payment delays."

**AI Provider:** OpenRouter (existing) — no new LLM dependencies.

### Phase 5: Recommended Actions Engine
Maps insights to concrete, prioritized actions with reasoning.

**Action taxonomy:**
```typescript
type RecommendedAction = {
  id: string;
  memberId: string;
  type: ActionType;
  priority: 'P0' | 'P1' | 'P2';
  confidence: number;         // 0-1, how confident the AI is
  reasoning: string;          // plain-English why this action
  suggestedChannel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_PERSON' | 'CALL';
  suggestedContent?: string;  // draft message template variable
  suggestedOffer?: {
    type: 'DISCOUNT' | 'FREEZE' | 'UPGRADE' | 'PT_SESSION' | 'ASSESSMENT';
    discountPercent?: number;
    freezeDays?: number;
  };
  automatable: boolean;        // can this run as automated workflow?
  createdAt: Date;
};
```

**Action types:**
- `OUTREACH_CHURN_RISK` — proactive contact
- `RENEWAL_NUDGE` — renewal window outreach
- `PAYMENT_PLAN` — offer installment option
- `FREEZE_OFFER` — temporary freeze for life events
- `UPGRADE_PITCH` — PT/nutrition upsell
- `ASSESSMENT_BOOK` — invite to fitness assessment
- `LOYALTY_REWARD` — thank champion before they lapse
- `RE_ENGAGEMENT` — win back lapsed member

### Phase 6: Automation Layer
Event-driven automations triggered by risk state changes and time windows.

**New automations:**
| Trigger | Condition | Action |
|---------|-----------|--------|
| `RISK_ESCALATION` | Member risk → HIGH/CRITICAL | Notify assigned trainer + manager |
| `CHURN_BEFORE_RENEWAL` | HIGH risk + renewal in 7d | Offer freeze/discount |
| `AT_RISK_NO_CONTACT` | HIGH risk + 0 outreach in 14d | Auto-create follow-up task |
| `CHAMPION_CHECKIN` | LOW risk + 12mo+ tenure | Send appreciation + upgrade invite |
| `PAYMENT_FAILED_AT_RISK` | Payment failed + HIGH risk | Retry + trainer alert |
| `RE_ENGAGEMENT_WINDOW` | Lapsed 14-30d | Offer re-engagement package |
| `GOAL_STALLED` | Milestone overdue 7d+ | Notify trainer to adjust plan |

### Phase 7: Smart Segmentation
Dynamic, rule-based member segments updated in real-time.

**Segment types:**
```typescript
type SegmentRule = {
  field: string;           // e.g., "riskScore", "status", "membership.planId"
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: any;
  logicalOp?: 'AND' | 'OR'; // when combined
};

type MemberSegment = {
  id: string;
  name: string;
  description: string;
  rules: SegmentRule[];
  createdByUserId: string;
  isSystem: boolean;        // system segments (At-Risk, Champions) not deletable
  memberCount: number;      // cached, updated on segment access
};
```

**System segments (auto-created, maintained):**
- `AT_RISK` — riskLevel HIGH or CRITICAL
- `CHURNING` — risk score > 70 for 14d+
- `CHAMPIONS` — LOW risk, tenure > 12mo, active in last 7d
- `RENEWAL_THIS_MONTH` — membership expires within 30d
- `NEW_MEMBERS` — joined within 90d
- `LAPSED` — 0 attendance in 30d
- `HIGH_VALUE` — total payments > $X threshold

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Member Intelligence OS                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  Risk Engine │───▶│  Analytics   │───▶│ Churn/Retention  │  │
│  │  (scoring)   │    │  (aggreg.)   │    │    Engine        │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│         │                   │                      │           │
│         ▼                   ▼                      ▼           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   AI Insights Layer                       │   │
│  │         (OpenRouter → explainable recommendations)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Recommended Actions Engine                   │   │
│  │         (prioritized, channel-specific, automatable)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         ▼                    ▼                    ▼            │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Automation  │    │  Smart Seg.  │    │   AI Chat    │      │
│  │  (triggers)  │    │  (segments)  │    │  (tools)     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
           │                                           │
           ▼                                           ▼
┌─────────────────────┐                    ┌─────────────────────────┐
│    Source of Truth   │                    │   Consumer Endpoints    │
│  (existing Member OS)│                    │  (dashboard, AI chat)  │
│  Member, Attendance,│                    │  /members/intelligence  │
│  Payment, Membership │                    │  /members/recommendations
└─────────────────────┘                    └─────────────────────────┘
```

## Data Model

### New Prisma Models

```prisma
model MemberRiskProfile {
  id             String   @id @default(uuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  memberId       String
  member         Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)

  overallScore       Int             // 0-100
  riskLevel          RiskLevel       // LOW/MEDIUM/HIGH/CRITICAL
  trend              RiskTrend       // IMPROVING/STABLE/WORSENING
  contributingFactors Json           // RiskFactor[]
  protectiveFactors   String[]       // what's keeping score low

  computedAt DateTime @default(now())

  @@unique([memberId])
  @@map("member_risk_profiles")
}

enum RiskLevel {
  LOW
  MEDIUM
  HIGH
  CRITICAL
}

enum RiskTrend {
  IMPROVING
  STABLE
  WORSENING
}

model MemberSegment {
  id             String   @id @default(uuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  name        String
  description String?
  rules       Json            // SegmentRule[]
  isSystem    Boolean  @default(false)

  createdByUserId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([organizationId, isSystem])
  @@map("member_segments")
}

model MemberSegmentAssignment {
  id         String   @id @default(uuid())
  memberId   String
  segmentId  String
  createdAt  DateTime @default(now())

  @@unique([memberId, segmentId])
  @@map("member_segment_assignments")
}

model RecommendedAction {
  id             String   @id @default(uuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  memberId       String

  type           ActionType
  priority       Priority   // P0/P1/P2
  confidence     Float      // 0-1
  reasoning      String

  suggestedChannel   ChannelType?
  suggestedContent   String?
  suggestedOfferType String?
  discountPercent    Int?
  freezeDays         Int?

  status        ActionStatus @default(PENDING)
  assignedToUserId  String?
  completedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([organizationId, status])
  @@map("recommended_actions")
}

enum ActionType {
  OUTREACH_CHURN_RISK
  RENEWAL_NUDGE
  PAYMENT_PLAN
  FREEZE_OFFER
  UPGRADE_PITCH
  ASSESSMENT_BOOK
  LOYALTY_REWARD
  RE_ENGAGEMENT
}

enum Priority {
  P0
  P1
  P2
}

enum ChannelType {
  WHATSAPP
  SMS
  EMAIL
  IN_PERSON
  CALL
}

enum ActionStatus {
  PENDING
  ASSIGNED
  COMPLETED
  DISMISSED
  AUTOMATED
}
```

## API Design

### Endpoints

```
GET    /members/:memberId/intelligence     → MemberRiskProfile + insights
GET    /members/:memberId/recommendations → RecommendedAction[]
POST   /members/:memberId/recommendations/:actionId/execute
POST   /members/:memberId/recommendations/:actionId/dismiss

GET    /members/segments                  → MemberSegment[]
POST   /members/segments                  → Create segment
GET    /members/segments/:segmentId/members → Members in segment
DELETE /members/segments/:segmentId

GET    /analytics/risk-overview           → Org-level risk distribution
GET    /analytics/risk-trend              → 30/60/90d risk trend
GET    /analytics/revenue-at-risk        → MRR at risk by segment

GET    /automation/config                 → List automation rules
PUT    /automation/config/:ruleId        → Update automation rule
POST   /automation/config/:ruleId/toggle → Enable/disable
```

## Module Structure

```
src/
├── member-intelligence/
│   ├── member-intelligence.module.ts
│   ├── risk-engine/
│   │   ├── risk-engine.service.ts       # Core scoring algorithm
│   │   ├── risk-factors.ts             # Factor definitions
│   │   ├── risk-engine.controller.ts    # GET /members/:id/intelligence
│   │   └── risk-engine.service.spec.ts
│   ├── analytics/
│   │   ├── intelligence-analytics.service.ts
│   │   ├── intelligence-analytics.controller.ts
│   │   └── intelligence-analytics.service.spec.ts
│   ├── churn/
│   │   ├── churn-engine.service.ts      # Indicator detection
│   │   ├── churn-engine.service.spec.ts
│   ├── ai-insights/
│   │   ├── ai-insights.service.ts       # OpenRouter calls
│   │   ├── ai-insights.service.spec.ts
│   ├── recommendations/
│   │   ├── recommendations.service.ts
│   │   ├── recommendations.controller.ts
│   │   └── recommendations.service.spec.ts
│   ├── automation/
│   │   ├── intelligence-automation.scanner.ts
│   │   ├── intelligence-automation.processor.ts
│   ├── segments/
│   │   ├── segments.service.ts
│   │   ├── segments.controller.ts
│   │   ├── segments.service.spec.ts
│   │   └── segment-rules.ts             # Rule engine
│   └── dto/
│       ├── risk-profile.dto.ts
│       ├── recommendation.dto.ts
│       ├── segment.dto.ts
│       └── analytics.dto.ts
```

## Integration Points

1. **Risk Engine** reads from: `Member`, `Attendance`, `Membership`, `Payment`, `MemberGoal`, `MemberGoalMilestone`, `MemberTagAssignment`, `WorkoutSession`
2. **Analytics** reads from: `MemberRiskProfile` (computed), `Membership`, `Payment`
3. **AI Insights** calls OpenRouter (existing provider)
4. **Recommendations** writes `RecommendedAction` rows, reads `MemberRiskProfile`
5. **Automation** extends existing `automation/` module with new scanners
6. **Segments** writes `MemberSegment` + `MemberSegmentAssignment`, reads all member data
7. **AI Chat tools** expose new tools: `get_member_risk`, `get_member_recommendations`, `get_segment_members`, `get_revenue_at_risk`

## Testing Strategy

Each phase must pass before proceeding:
1. `npm run lint` — no lint errors
2. `npm run typecheck` — no type errors
3. `npm run test` — all unit tests pass
4. `npm run test:e2e` — all e2e tests pass
5. `npm run build` — builds successfully

## Performance Considerations

- **Risk scoring**: Computed on-demand with 1-hour cache (via `computedAt` check)
- **Batch recomputation**: Nightly job via existing `automation-scheduler` for full org refresh
- **Segment membership**: Materialized on read with background refresh
- **AI Insights**: 500ms timeout, cached for 1 hour per member
- **Database indexes**: All foreign keys + `computedAt` + `riskLevel` indexed

## Security & Multi-Tenancy

- All queries filter by `organizationId` from JWT
- Risk scores are org-scoped — no cross-org leakage
- Segment rules validated server-side (no raw field injection)
- AI insights filtered by org membership
- `isSystem` segments are read-only for non-platform admins

## Rollout Phases

| Phase | Component | Delivery |
|-------|-----------|----------|
| 1 | Risk Engine | `risk-engine.service.ts`, `MemberRiskProfile` model, `GET /members/:id/intelligence` |
| 2 | Analytics Engine | `intelligence-analytics.service.ts`, risk dashboard endpoints |
| 3 | Churn/Retention | `churn-engine.service.ts`, churn indicators |
| 4 | AI Insights | `ai-insights.service.ts`, OpenRouter integration |
| 5 | Recommendations | `recommendations.service.ts`, `RecommendedAction` model |
| 6 | Automation | 7 new automation scanners |
| 7 | Smart Segmentation | `segments.service.ts`, `MemberSegment` model, CRUD endpoints |
