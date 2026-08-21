# Entity relationship diagram

Generated from `prisma/schema.prisma`. Covers the "deep foundation" tables only — deferred domains
(payments, workouts, nutrition, inventory, ...) aren't modeled yet; see `docs/ARCHITECTURE.md` for
how they'll attach to `Organization`/`Branch`/`Member`/`User` when built.

```mermaid
erDiagram
    ORGANIZATION ||--o{ BRANCH : has
    ORGANIZATION ||--o{ USER : employs
    ORGANIZATION ||--o{ MEMBER : has
    ORGANIZATION ||--o{ ROLE : "defines custom"
    ORGANIZATION ||--o{ MEMBERSHIP_PLAN : offers
    ORGANIZATION ||--o{ MEMBERSHIP : has
    ORGANIZATION ||--o{ ATTENDANCE : has
    ORGANIZATION ||--o{ AUDIT_LOG : has
    ORGANIZATION ||--o{ ORGANIZATION : "parent of (franchise)"

    BRANCH ||--o{ STAFF_PROFILE : has
    BRANCH ||--o{ MEMBERSHIP_PLAN : "scoped to (optional)"
    BRANCH ||--o{ MEMBERSHIP : has
    BRANCH ||--o{ ATTENDANCE : has
    BRANCH ||--o{ MEMBER : "primary branch of"
    BRANCH ||--o{ USER : "primary branch of"

    USER ||--o| STAFF_PROFILE : "has (if staff)"
    USER ||--o| MEMBER : "portal login for (optional)"
    USER ||--o{ USER_ROLE : "assigned via"
    USER ||--o{ USER_PERMISSION_OVERRIDE : has
    USER ||--o{ REFRESH_TOKEN : has
    USER ||--o{ MEMBER : "assigned trainer for"
    USER ||--o{ ATTENDANCE : "staff check-in"
    USER ||--o{ AUDIT_LOG : "acted as"

    ROLE ||--o{ ROLE_PERMISSION : grants
    ROLE ||--o{ USER_ROLE : "assigned as"
    PERMISSION ||--o{ ROLE_PERMISSION : "granted via"
    PERMISSION ||--o{ USER_PERMISSION_OVERRIDE : "overridden via"
    USER_ROLE }o--|| BRANCH : "optionally scoped to"

    MEMBER ||--o{ MEMBERSHIP : subscribes
    MEMBER ||--o{ ATTENDANCE : "checks in"
    MEMBERSHIP_PLAN ||--o{ MEMBERSHIP : "instantiated as"
    MEMBERSHIP |o--o| MEMBERSHIP : "previous/next (chain)"

    ORGANIZATION {
        uuid id PK
        string slug UK
        enum status
        uuid parentOrganizationId FK
        datetime deletedAt
    }
    BRANCH {
        uuid id PK
        uuid organizationId FK
        string slug
        enum status
        datetime deletedAt
    }
    USER {
        uuid id PK
        uuid organizationId FK "null for platform staff"
        enum platformRole "null unless platform staff"
        string email UK
        enum status
        uuid primaryBranchId FK
        datetime deletedAt
    }
    STAFF_PROFILE {
        uuid id PK
        uuid userId FK UK
        uuid organizationId FK
        uuid branchId FK
        bool isTrainer
    }
    ROLE {
        uuid id PK
        uuid organizationId FK "null = system role"
        string key
        bool isSystem
    }
    PERMISSION {
        uuid id PK
        string key UK "resource.action"
    }
    USER_ROLE {
        uuid id PK
        uuid userId FK
        uuid roleId FK
        uuid organizationId FK
        uuid branchId FK "null = org-wide"
    }
    USER_PERMISSION_OVERRIDE {
        uuid id PK
        uuid userId FK
        uuid permissionId FK
        enum effect "ALLOW or DENY, DENY wins"
    }
    MEMBER {
        uuid id PK
        uuid organizationId FK
        uuid primaryBranchId FK
        string memberCode "unique per org"
        enum status
        uuid assignedTrainerId FK
        uuid userId FK UK "portal login, optional"
        datetime deletedAt
    }
    MEMBERSHIP_PLAN {
        uuid id PK
        uuid organizationId FK
        uuid branchId FK "null = all branches"
        decimal price
        bool isActive
    }
    MEMBERSHIP {
        uuid id PK
        uuid organizationId FK
        uuid branchId FK
        uuid memberId FK
        uuid membershipPlanId FK
        enum status
        decimal price "snapshotted at purchase"
        uuid previousMembershipId FK UK
    }
    ATTENDANCE {
        uuid id PK
        uuid organizationId FK
        uuid branchId FK
        uuid memberId FK "xor staffUserId"
        uuid staffUserId FK "xor memberId"
        enum method
    }
    AUDIT_LOG {
        uuid id PK
        uuid organizationId FK "nullable, SetNull on org delete"
        uuid actorUserId FK "nullable, SetNull on user delete"
        string action
        string resource
        json beforeState
        json afterState
    }
```

## Notable relationship decisions

- **`Membership` price is snapshotted**, not a live reference to `MembershipPlan.price` — a plan
  price change must never retroactively alter a member's already-purchased membership. This is the
  same principle billing/payments will need when built: financial records reference-copy the price
  at transaction time.
- **`Membership.previousMembershipId`** forms a linked chain (freeze → new period, upgrade →
  downgrade) instead of mutating a row in place, preserving full history.
- **`AuditLog.organizationId`/`actorUserId` use `onDelete: SetNull`**, not `Cascade` — deleting an
  organization or user must never delete the audit trail that recorded what they did. See
  `data-retention.md`.
- **`Attendance` has an implicit XOR** (`memberId` vs `staffUserId`) enforced in the service layer,
  not a DB constraint — Postgres doesn't have a clean native way to express "exactly one of these two
  nullable FKs is set" without a `CHECK` constraint referencing both columns; worth adding as an
  explicit `CHECK` if this table ever gets a second write path that could violate it accidentally.
- **`MemberStatusHistory`/`MemberBranchHistory`/`MemberTrainerHistory`** follow the same
  snapshot-not-live-reference principle as `Membership.price` above, applied to `Member`'s own
  mutable fields: every `status`/`primaryBranchId`/`assignedTrainerId` change gets an append-only
  row (written inside the same transaction as the `Member` update, seeded on creation too so the
  original value isn't invisible), rather than the flat `Member` row being the only record of
  "what it is now" with no trail of "what it was."

**Diagram note**: the mermaid diagram above predates `billing`/`workouts`/`nutrition`/`inventory`/
`crm`/`ai`/Member 360 — it still only draws the deep-foundation-phase tables. Not redrawn here;
`prisma/schema.prisma` is the authoritative source for the full current model.
