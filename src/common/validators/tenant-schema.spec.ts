import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A schema-level guard on tenant ownership.
 *
 * Application-level scoping is a promise each of ~40 services keeps by
 * hand, and there is no Row Level Security underneath to catch a missed
 * `where`. This suite does not replace that, but it closes the specific
 * structural hole that lets the promise be broken silently: a table
 * that joins a tenant-owned parent but has no `organizationId` of its
 * own, so a query against it returns the right rows only if the author
 * remembered to traverse the relation.
 *
 * Every model below is reachable from a tenant-owned parent, so "derive
 * the tenant by joining" is always *possible* and never *enforced*.
 */
const SCHEMA = join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma');

/**
 * Models that legitimately have no organizationId:
 *  - the global catalogs and the Organization model itself
 *  - per-user secrets, where the tenant is derived from `userId`
 *  - platform billing, which is deliberately cross-tenant
 *  - rows only reachable through an already-verified parent, listed
 *    explicitly so adding a new one has to be a deliberate decision
 *    rather than an omission.
 */
const EXEMPT: Record<string, string> = {
  Organization: 'the tenant itself',
  Permission: 'global catalog',
  Role: 'system roles have no owner; org roles do',
  RolePermission: 'derived through roleId',
  User: 'nullable = platform staff',
  RefreshToken: 'derived through userId',
  PasswordResetToken: 'derived through userId',
  EmailVerificationToken: 'derived through userId',
  UserMfa: 'derived through userId',
  MfaRecoveryCode: 'derived through userId',
  MemberOtpChallenge: 'derived through userId',
  SubscriptionPlan: 'global SaaS catalog',
  OrganizationSubscription: 'cross-tenant platform billing',
  PlatformInvoice: 'cross-tenant platform billing',
  PlatformUsageRecord: 'cross-tenant platform billing',
  InvoicePayment: 'reached only through an org-scoped Invoice',
  WaAuthKey: 'reached only through an org-scoped WaSession',
  WaContact: 'reached only through an org-scoped WaSession',
  DunningAttempt: 'reached only through an org-scoped Invoice',
  RazorpayOrder: 'reached only through an org-scoped Invoice',
  RazorpayWebhookEvent: 'provider delivery ledger keyed on event id',
  AiMessage: 'reached only through an org-scoped AiConversation',
  InventoryPurchaseOrderItem:
    'reached only through an org-scoped purchase order',
  InventoryTransferItem: 'reached only through an org-scoped transfer',
  InventorySaleItem: 'reached only through an org-scoped sale',
  AuditLog: 'nullable: platform-level events have no tenant',
  AiUsageLog: 'nullable: platform-level LLM usage has no tenant',
  MessageTemplate: 'nullable: a null row is a system default',
  MessageLog:
    'nullable: a member whose User has no organizationId can trigger a send',
  MemberQrToken:
    'keyed on memberId alone; the check-in lookup joins through it',
  PublicEndpointRateLimit: 'keyed on caller identity, not on a tenant',
};

function parseModels(): Map<string, string> {
  const src = readFileSync(SCHEMA, 'utf8');
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Strip comments before anything is matched against the body. Several
    // of these models discuss `organizationId String?` in their doc
    // comment while declaring it non-null, and a naive match reads the
    // prose as the field.
    const body = m[2]
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    models.set(m[1], body);
  }
  return models;
}

/**
 * Tenant columns that exist but carry no foreign key, so the database
 * will accept an `organizationId` that names no organization at all.
 *
 * A ratchet, not a whitelist. Each of these is a real integrity gap: a
 * service that writes the wrong org id gets no complaint from Postgres,
 * and every later query filtered on that column silently returns the
 * wrong tenant's rows. The list is asserted exactly, so adding a sixth
 * fails this suite and fixing one asks you to shorten the list.
 *
 * Fixing them needs a migration that can only be proven against a real
 * database (`prisma migrate diff` + the data guard), which is why it is
 * tracked here rather than done blind.
 */
const TENANT_FK_GAPS = [
  'StaffProfile',
  'TrainerCommission',
  'TrainerCommissionRule',
  'UserPermissionOverride',
];

describe('tenant ownership of the data model', () => {
  const models = parseModels();

  it('parses the schema at all', () => {
    expect(models.size).toBeGreaterThan(80);
  });

  it('every member sub-table carries its own organizationId', () => {
    // The sub-tables hanging off a Member are the ones that got missed:
    // the member is tenant-owned, so these are reachable with a bare
    // primary key, and a query that does not traverse to the member
    // returns whatever it likes.
    const offenders: string[] = [];
    for (const [name, body] of models) {
      if (!/model\s+Member\w+/.test(name)) continue;
      if (EXEMPT[name]) continue;
      if (!/organizationId\s+String/.test(body)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('every organizationId is NOT NULL rather than optional', () => {
    // `organizationId String?` on a tenant table means a row can exist
    // with no tenant, which is exactly the row a cross-tenant query
    // would surface.
    const offenders: string[] = [];
    for (const [name, body] of models) {
      if (EXEMPT[name]) continue;
      if (/organizationId\s+String\?/.test(body)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('an organizationId is backed by a real foreign key, not a bare string', () => {
    const offenders: string[] = [];
    for (const [name, body] of models) {
      if (EXEMPT[name]) continue;
      if (!/organizationId\s+String\b/.test(body)) continue;
      // The relation may be named, e.g. `@relation("PtSession", fields: ...)`.
      if (!/@relation\((?:"[^"]*",\s*)?fields: \[organizationId\]/.test(body)) {
        offenders.push(name);
      }
    }
    // Asserted exactly: a new gap fails, a fixed one asks to be removed.
    expect(offenders.sort()).toEqual([...TENANT_FK_GAPS].sort());
  });

  it('no model lacks an exemption it should have declared', () => {
    // The point of EXEMPT being explicit: a NEW model with no
    // organizationId has to be a deliberate decision recorded in this
    // file, not an oversight the other three tests quietly skip.
    const unaccounted = [...models.keys()].filter(
      (name) =>
        !EXEMPT[name] &&
        !/organizationId\s+String\b/.test(models.get(name) as string) &&
        // Enums are not models and cannot be matched this way.
        !new RegExp(`^model\\s+${name}\\s*\\{`).test(
          readFileSync(SCHEMA, 'utf8'),
        ),
    );
    expect(unaccounted).toEqual([]);
  });
});
