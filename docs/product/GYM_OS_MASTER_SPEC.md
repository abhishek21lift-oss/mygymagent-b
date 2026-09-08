# MyGymAgent — Gym Operating System Master Specification

## Product mission

MyGymAgent is a multi-tenant gym operating system, not merely a membership CRUD application. It must help an owner answer three questions continuously: **what is happening, what is at risk, and what should I do next?** AI is an operational copilot layered on top of verified domain services; it must never bypass tenant, branch, permission, audit, or approval boundaries.

## Tenant model

Every organization is an isolated tenant. Branches are subordinate operating units. Every tenant-owned read/write, background job, file, cache key, AI conversation/tool execution, notification, analytics query and export must carry verified organization context. Branch scope must be derived from authenticated permissions or validated branch context, never trusted from model/user input alone.

## Product domains

1. Organization & branches — onboarding, settings, staff, roles, permissions, operating hours, branding.
2. Members — Member 360, lifecycle, attendance, memberships, payments, notes, goals, assessments, documents, retention.
3. PT OS — trainer assignment, sessions, packages, balances, workouts, nutrition, progress, commissions, payouts, trainer KPIs.
4. Sales & CRM — leads, pipeline, follow-ups, conversion, campaigns, lost-lead recovery.
5. Revenue — payments, refunds, invoices, discounts/tax, outstanding balances, recurring revenue, expenses and trainer payouts.
6. Inventory — products, purchases, stock movements, sales, expiry, low-stock and forecasting.
7. Attendance — check-in/out, daily operations, member engagement and anomaly detection.
8. Communications — WhatsApp, email, SMS and push through provider adapters, templates, consent, delivery state and retries.
9. Analytics — revenue, retention, churn, attendance, sales, PT performance, branch performance and inventory.
10. SaaS platform — plans, trials, feature flags, usage limits, platform subscriptions, invoices, suspension/grace period and super-admin controls.

## AI Gym OS

AI capabilities must be action-oriented and permission-aware:

- Owner Copilot: daily briefing, anomalies, revenue/retention explanations and prioritized actions.
- Sales Copilot: lead prioritization, follow-up drafts, conversion insights.
- Retention Copilot: churn-risk detection and recovery recommendations.
- Trainer Copilot: session preparation, workout/nutrition drafts and client progress summaries.
- Finance Copilot: revenue summaries, overdue-payment analysis and cash-flow insights.
- Inventory Copilot: low-stock, expiry and reorder recommendations.
- Member Copilot: safe member-facing guidance using only authorized member context.

AI must use typed tools/domain services, never arbitrary SQL. Model-supplied organizationId, branchId, userId or permission claims are untrusted. Consequential mutations require explicit approval unless a separately audited automation policy permits them. Every AI tool execution must be auditable.

## Owner command center

The primary dashboard should surface:

- today's check-ins, new joins, renewals, revenue, outstanding payments and PT sessions;
- expiring memberships and inactive members;
- new/uncontacted leads and conversion opportunities;
- trainer workload and exceptions;
- inventory risks;
- AI-generated briefing with evidence and recommended actions.

Every insight should link to the underlying records and provide a safe next action.

## Automation

Use domain events + BullMQ for retryable workflows. Important automation candidates: membership expiry, failed payment, inactive-member recovery, lead follow-up, birthday/engagement messages, low-stock alerts and scheduled owner briefings. Jobs must be idempotent, tenant-scoped and observable.

## SaaS controls

Plans and limits are data-driven. Server-side enforcement is mandatory for members, branches, staff, storage, AI usage, communications and API usage. UI limits are only UX. Platform billing must remain separate from gym-side member payments.

## Non-negotiable engineering rules

- No cross-tenant access.
- No client-controlled authorization context.
- No AI authorization bypass.
- No financial mutation that destroys historical truth.
- No unbounded list query in production paths.
- No consequential automation without auditability and appropriate approval.
- Every major domain flow needs integration/e2e coverage for authorization and failure paths.
- Frontend permission checks are UX only; backend authorization is authoritative.
- Preserve existing working domain services; extend rather than duplicate them.

## Definition of complete

A capability is complete only when its database model, domain service, API, authorization, frontend workflow, error/loading/empty states, audit behavior, tests, tenant isolation and operational behavior are all verified. Documentation must describe actual behavior, not aspirational architecture.
