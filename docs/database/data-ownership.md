# Data ownership matrix

For every table in `prisma/schema.prisma`, answered before any implementation touched it (per the
spec's "do not proceed until these questions are resolved" rule). "AI access" is forward-looking —
the `ai` module doesn't exist yet — and states the intended boundary for when it does, per
`docs/ai/architecture.md`'s explicit-tool-allowlist rule.

| Entity | Owner | Tenant scope | Branch scope | Reads | Writes | Historical | Soft-deletable | Audited | AI access | API-exposed |
|---|---|---|---|---|---|---|---|---|---|---|
| `Organization` | Platform (created at signup) | Is the tenant root | — | Org's own users (their org); platform admins (all) | Org owner/admin; platform admins | No (mutable settings) | Yes (`deletedAt`) | Yes | Read-only, org-scoped | Yes, org-scoped |
| `Branch` | Organization | Owning org | Is the branch | Org's users per role/branch scope | Org/branch admins | No | Yes (`deletedAt`) | Yes | Read-only, org-scoped | Yes |
| `User` | Organization (or platform, if `platformRole` set) | Owning org, nullable for platform staff | Optional `primaryBranchId` | Self; org admins; platform admins for platform users | Self (profile fields); org admins (role/status); never self-service `platformRole` | No | Yes (`deletedAt`) | Yes (all auth/role changes) | No — PII, never handed to a model directly; a future AI feature reads derived, minimal fields only (e.g. "assigned trainer's name") via an explicit tool, never the raw row | Yes, own org only |
| `StaffProfile` | Organization | Owning org (via `organizationId`) | Optional `branchId` | Org users per permission | Org admins; self (bio/specializations) | No | No — cascades with `User` | Yes | Yes, for trainer-context tools (e.g. "who are this member's trainers") | Yes |
| `Permission` | Platform | Global, not tenant-scoped | — | Any authenticated user (to render UI) | Platform only (seed script, `prisma/seed.ts`) | No | No | No (reference data, not an event) | No — not member/business data | Yes, read-only |
| `Role` | Platform (system roles) or Organization (custom roles) | Nullable = system, else owning org | — | Org's users | Org admins (custom roles only — system roles are seed-managed) | No | No | Yes (custom role changes) | No | Yes |
| `RolePermission` | Same as its `Role` | Follows `Role` | — | Follows `Role` | Follows `Role` | No | No | Yes (via role audit) | No | Yes (as part of role detail) |
| `UserRole` | Organization | `organizationId` | Optional `branchId` | Org admins | Org admins | No — but changes are audit events | No | Yes | No | Yes |
| `UserPermissionOverride` | Organization | `organizationId` | Optional `branchId` | Org admins | Org admins | No | No | Yes | No | Yes |
| `RefreshToken` | User (security artifact) | Via `User.organizationId` | — | Never exposed to clients — server-internal only | Auth service only | Yes — kept for revocation/device-list history, never mutated except `revokedAt` | No — `revokedAt` marks it dead, row kept for forensics | Yes (issuance/rotation/revocation) | No | No — never returned by any endpoint |
| `PasswordResetToken` / `EmailVerificationToken` | User | Via `User.organizationId` | — | Server-internal only | Auth service only | Yes | No | Yes | No | No |
| `AuditLog` | Platform (compliance record) | `organizationId`, nullable so it survives org deletion | Optional `branchId` | Org admins (own org); platform admins (all) | System only — application code writes these via `@Audited()`, nothing ever updates or deletes a row | Yes — this **is** the historical record | **No — never deleted**, see `data-retention.md` | N/A — it is the audit mechanism | Read-only, for anomaly-detection tooling only, never as training data | Yes, read-only, paginated |
| `Member` | Organization (the gym's client) | `organizationId` | `primaryBranchId` | Org/branch staff per role; the member themself if portal login is enabled | Front-desk/branch-manager roles; member (self-service fields only, once portal login exists) | No (current-state row; history lives in `Membership`/`Attendance`) | Yes (`deletedAt`) | Yes (create/update/assign-trainer) | Yes, via explicit tools only (`read_member`, never a raw table scan) — see `docs/ai/architecture.md` | Yes, org-scoped |
| `MembershipPlan` | Organization | `organizationId` | Optional `branchId` (null = all branches) | Anyone in the org (for sales UI); public read for a future member-signup flow | Org admins | No (current catalog) | No — `isActive` flag retires a plan instead; deleting a plan a member is subscribed to would orphan `Membership.membershipPlanId` | Yes | Yes (read-only, for plan-recommendation tools) | Yes |
| `Membership` | Organization / Member jointly | `organizationId` | `branchId` | Org/branch staff; the member | Sales/front-desk roles; billing (once built) | **Yes — financial record.** `price` is snapshotted at purchase, never re-derived from the plan | **No — never hard-deleted.** Cancellation is `status = CANCELLED`, not row deletion | Yes | Yes, via explicit tools, read-only | Yes |
| `Attendance` | Member or staff (whoever checked in) | `organizationId` | `branchId` | Org/branch staff; the member (own history) | Kiosk/app/staff check-in flows | Yes — append-only log of check-ins | No — never deleted, it's the historical record itself | Create events audited at high volume via metrics, not per-row `AuditLog` rows (see `data-retention.md`) | Yes, aggregate/summarized only (e.g. "visits this month"), never a raw dump | Yes |

## Cross-cutting rules encoded above

1. **Financial/historical rows are never hard-deleted** (`Membership`, `AuditLog`) — status/flag
   fields represent lifecycle state instead. This is the same rule §52 (Data Retention) requires for
   the payments/billing tables that don't exist yet.
2. **AI access is opt-in per field, not per table** — even where "Yes" is marked above, the
   intended mechanism (once the `ai` module is built) is a narrow, named tool
   (`read_member`, `read_attendance`, ...) that returns a defined shape, never raw row access or a
   generic query capability. See `docs/ai/architecture.md`.
3. **Security-artifact tables** (`RefreshToken`, `*Token`) are never API-exposed even to their
   owning user — they're bearer-secret hashes, not user-facing data.
