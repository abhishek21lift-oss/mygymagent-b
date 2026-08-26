# MYGYMAGENT MASTER TASK

## MASTER MISSION

Build MyGymAgent into a **complete, production-grade, AI-driven, multi-tenant Gym Operating System (Gym OS)**.

This is NOT only a PT OS.

PT is one major subsystem inside the complete Gym OS.

The product must eventually allow a gym owner/operator to run the entire gym business from one platform while AI continuously understands the business, identifies risks/opportunities, recommends actions, and executes authorized actions safely.

## PRODUCT POSITIONING

MyGymAgent = **Complete Gym OS + AI OS**.

Strategic foundation:
- Mature gym-management operational depth
- AI-native intelligence and automation
- MyGymAgent's own architecture, UX, tenancy, scalability and product differentiation

Do not build a simple clone of another product.
Do not build a chatbot sitting on top of gym software.
Build an actual AI-native Gym Operating System.

## CORE PRODUCT DOMAINS

The complete Gym OS must cover, as applicable:

- Platform / SaaS administration
- Organizations / tenants
- Multi-location / branches
- Users / staff / trainers
- Authentication / RBAC / permissions
- Members / Member 360
- Memberships / plans / renewals / freezes / transfers
- Attendance / check-in / check-out
- Leads / CRM / sales / follow-ups
- Personal Training (PT OS)
- PT packages / purchases / sessions / scheduling / trainer assignment / commissions / payouts
- Workouts / exercise library / programming / assignments / progress
- Nutrition / diet programming / adherence
- Assessments / measurements / goals / milestones / progress
- Billing / payments / refunds / invoices
- Expenses / revenue / financial reporting
- Inventory / products / stock / purchasing
- Communications / email / SMS / WhatsApp / push / in-app notifications
- Tasks / reminders / workflows
- Files / documents / media
- Reports / dashboards / analytics
- Facilities / resources where required
- Platform subscription / SaaS billing
- Audit / security / observability

## AI OS

AI is an intelligence and operations layer across the entire Gym OS, not a cosmetic feature.

Target flow:

DATA -> DOMAIN SERVICES -> AI CONTEXT -> INTELLIGENCE -> RECOMMENDATION -> APPROVAL/CONTROL -> ACTION -> VERIFICATION

AI capabilities should eventually include:

- Member intelligence: churn risk, engagement, renewal prediction, attendance anomalies, adherence, progress
- PT intelligence: client progress, missed sessions, utilization, PT revenue, trainer performance
- Sales intelligence: lead qualification, conversion prediction, follow-up prioritization
- Finance intelligence: revenue trends, anomalies, forecasting, expenses, commissions and payouts
- Inventory intelligence: demand, low-stock prediction, purchasing recommendations
- Operations intelligence: daily priorities, exceptions, staffing/resource issues
- Owner intelligence: business health, explanations, forecasts and recommended actions

## AI AGENTS

Use specialized, permissioned agents rather than one unrestricted AI:

- Member Agent
- Sales Agent
- PT Agent
- Finance Agent
- Operations Agent
- Inventory Agent
- Business Intelligence Agent
- Owner Copilot

Every agent must have:
- Identity
- Purpose
- Tenant context
- Permissions
- Allowed tools
- Inputs/outputs
- Guardrails
- Failure handling
- Auditability

AI must never directly receive unrestricted production database access.
AI tools must use the same tenant-scoped domain services and authorization boundaries as normal application operations.
Consequential actions require appropriate permission and, where needed, explicit approval.

## NON-NEGOTIABLE ARCHITECTURAL RULES

1. Multi-tenancy is mandatory.
2. Tenant isolation must hold across authentication, authorization, API, services, database access, jobs, events, storage, analytics, reports and AI context/tools.
3. Never trust a client-supplied organization/tenant ID for authorization.
4. Never fabricate business data, KPIs, analytics, predictions or AI metrics.
5. If data is unavailable, say Data unavailable.
6. Preserve existing production functionality.
7. Prefer extending/refactoring the existing foundation over rewriting it.
8. Use evidence before declaring a root cause.
9. Security > tenant isolation > data integrity > production functionality > explicit feature request > architecture consistency > performance > UX > AI enhancements > experiments.
10. Never casually create destructive database migrations.
11. Never edit/delete an already-applied Prisma migration.
12. No manual production schema edits; use committed Prisma migrations.
13. AI must be least-privilege and auditable.
14. Core gym operations must not depend on AI availability.
15. Keep the backend as a modular monolith until scale provides a genuine reason to split services.

## CURRENT FOUNDATION

Backend:
- Repository: mygymagent-b
- NestJS modular monolith
- PostgreSQL + Prisma
- JWT auth + refresh-token rotation
- RBAC / branch / assignment scoping
- Audit logging
- Domain event bus
- BullMQ + Redis
- AI v1 tool-calling architecture

Frontend:
- Repository: mygymagent-f
- Next.js App Router
- TypeScript
- Permission-aware UI
- Typed API client
- API URL injected at build time

Infrastructure target:
- Hostinger VPS
- Nginx
- Docker
- Supabase/PostgreSQL as production database target unless architecture audit proves otherwise
- Production Redis
- Cloudflare R2 for object storage
- OpenRouter for AI provider initially

## CURRENT VPS STATE

- Ubuntu 24.04.4 LTS
- Docker 29.7.1
- Docker Compose 5.4.0
- Nginx 1.24.0
- Existing MyPTStudio production containers must not be broken
- Old /opt/mygymagent/mgc-backend has been removed
- MyGymAgent backend is at /opt/mygymagent/backend
- MyGymAgent frontend is at /opt/mygymagent/frontend
- Current repository branches checked out on VPS are main

## CURRENT VERIFIED REPO COMMITS

Backend main:
- 709f0f9 — feat: add evidence-backed workout progress intelligence

Frontend main:
- 4b51d63 — feat: add AI workout progress to Member 360

## CURRENT DEPLOYMENT STATE

The MyGymAgent domain has NOT yet been purchased.

Do not configure production DNS/SSL based on an assumed domain.
When a domain is purchased, preferred SaaS routing is:
- app.<domain> -> frontend
- api.<domain> -> backend

Existing MyPTStudio domains must remain untouched.

## CURRENT PHASE

**Phase 0 — Architecture, Security and Production Foundation**

We are auditing and preparing the current system for safe VPS production deployment while preserving the broader product mission.

## ARCHITECTURE AUDIT CONCLUSIONS

KEEP:
- Modular monolith
- PostgreSQL + Prisma
- Service-layer tenant isolation
- RBAC / permissions
- Domain modules
- Event bus
- Controlled AI tool architecture
- Docker production image strategy

IMPORTANT GAPS / FUTURE WORK:
- PT commerce/session/commission/payout domain needs completion
- Scheduling/appointments needs completion
- Complete finance/expense/revenue architecture needs expansion
- Communications/WhatsApp/SMS needs expansion
- Analytics/search need proper implementation
- AI persistence, routing, budget controls, approvals and deeper intelligence need expansion
- Production observability needs hardening
- Architecture documentation must stay synchronized with actual code

## IMMEDIATE WORK ORDER

1. Finish architecture/security audit and record evidence.
2. Establish safe VPS production infrastructure without touching MyPTStudio.
3. Establish production environment/secrets safely.
4. Verify database and Redis targets before starting application containers.
5. Build and verify backend production image.
6. Build and verify frontend production image with the real API URL only when domain/API routing is known.
7. Configure Nginx/SSL only after domain purchase and DNS confirmation.
8. Verify /health and /ready.
9. Verify authentication, cookies, CORS and tenant isolation in production-like conditions.
10. Only then proceed into the next product implementation phase.

## CODING / AUDIT MODE

When the user says Audit or Architecture Audit:
- Read and inspect only.
- Do not modify code.
- Report Confirmed / Likely / Possible / Unknown.
- Identify severity P0/P1/P2/P3.

When the user says Fix or Implement:
- Inspect architecture first.
- Make the smallest safe change.
- Consider frontend/backend/database/tenancy/security impacts.
- Test and verify.
- Never claim done without appropriate verification.

## ANTI-DRIFT CHECK

Before every significant implementation step, silently answer:

- What is the master mission?
- What exact task are we solving now?
- What has already been completed?
- What is the next logical action?
- Does this change scope?
- Could this affect tenant isolation?
- Am I using real evidence/data?
- How will completion be verified?

If drift is detected, stop and return to the current task.

## TASK STATE

MASTER MISSION:
Complete AI-driven multi-tenant Gym OS.

CURRENT PHASE:
Architecture / Security / VPS Production Foundation.

CURRENT TASK:
Maintain the master product direction and prepare the existing MyGymAgent foundation for safe production deployment.

COMPLETED:
- Repository discovery
- VPS discovery
- Dockerfile inspection
- Frontend API/auth inspection
- CORS/cookie inspection
- Nginx inspection
- Architecture audit
- Product direction corrected from PT-only framing to Complete Gym OS + AI OS

IN PROGRESS:
- Production architecture and deployment preparation

BLOCKED:
- Public DNS/SSL until a production domain is purchased

NEXT ACTION:
Continue the current production-foundation work from the latest verified state; do not restart or redesign the project.

IMPORTANT DECISIONS:
- MyGymAgent is a complete Gym OS, not only PT OS.
- PT is one major subsystem of Gym OS.
- AI is the intelligence/operations layer across the entire Gym OS.
- Extend and harden the existing foundation; do not rewrite without evidence.
- Security and tenant isolation are non-negotiable.

## PERSISTENCE / READING RULE

This file is the project source-of-truth task state for long-running work.

Before a significant implementation step, reread this file (or the current synchronized task state) so the master mission and current task are not forgotten.

The assistant must never silently replace the master mission with a temporary bug, UI task, deployment task, PT feature, or AI feature.

The desired operational cadence is to re-check the task state approximately every 10 minutes during active work. If the environment cannot perform 10-minute checks, use the highest supported safe cadence and re-read it before each significant action instead of pretending a 10-minute automated check exists.
