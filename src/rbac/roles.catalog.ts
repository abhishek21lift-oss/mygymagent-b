import { PERMISSION_KEYS } from './permissions.catalog';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}
const ALL_PERMISSIONS = PERMISSION_KEYS;
const perms = (...keys: string[]) => keys;

/**
 * The roles an organization's second-factor policy covers
 * (`MfaPolicy.REQUIRED_FOR_PRIVILEGED`).
 *
 * These three hold `ALL_PERMISSIONS` or the money-handling subset: taking
 * one over means taking over billing, payroll and the accounting ledger,
 * which is the exposure that motivated shipping TOTP in the first place.
 * BRANCH_MANAGER is deliberately out -- it cannot change organization
 * settings or touch accounting, and sweeping it in would multiply the
 * rollout's lockout surface for little gain.
 */
/**
 * Roles that exist in the catalogue but must never be handed out inside an
 * organization.
 *
 * Platform routes are gated on `User.platformRole`, not on an RBAC grant,
 * so granting one of these to a staff member confers nothing a platform
 * role implies. It only hands them every ordinary permission, under a name
 * that reads as far more than that to anyone auditing the staff list.
 */
export const PLATFORM_ONLY_ROLE_KEYS = [
  'PLATFORM_OWNER',
  'PLATFORM_ADMIN',
] as const;

export const MFA_PRIVILEGED_ROLE_KEYS = [
  'ORG_OWNER',
  'ORG_ADMIN',
  'ACCOUNTANT',
] as const;

export type MfaPrivilegedRoleKey = (typeof MFA_PRIVILEGED_ROLE_KEYS)[number];

export const ROLES_CATALOG: RoleDefinition[] = [
  {
    key: 'PLATFORM_OWNER',
    name: 'Platform Owner',
    description: 'Full control over the platform across all organizations.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'PLATFORM_ADMIN',
    name: 'Platform Admin',
    description: 'Platform-level administration and support access.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'ORG_OWNER',
    name: 'Organization Owner',
    description:
      'Full control over a single organization and all its branches.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'ORG_ADMIN',
    name: 'Organization Admin',
    description: 'Administers organization settings, staff, and all branches.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'BRANCH_MANAGER',
    name: 'Branch Manager',
    description: 'Manages day-to-day operations for one or more branches.',
    permissions: perms(
      'branches.read',
      'users.read',
      'members.read',
      'members.create',
      'members.update',
      'members.assign_trainer',
      'membership_plans.read',
      'memberships.read',
      'memberships.create',
      'memberships.update',
      'attendance.read',
      'attendance.create',
      'payments.read',
      'payments.create',
      'inventory.read',
      'inventory.manage',
      'leads.read',
      'leads.manage',
      'reports.view',
      'audit.read',
      'pt-sessions.read',
      'pt-sessions.create',
      'pt-sessions.update',
      'pt-packages.read',
      'pt-packages.create',
      'pt-packages.update',
      'appointments.read',
      'appointments.create',
      'appointments.update',
      'appointments.manage_availability',
      'expenses.read',
      'expenses.create',
      'expenses.update',
      'hr.read',
      'hr.manage',
      'whatsapp.read',
      'whatsapp.manage',
      'classes.read',
      'classes.manage',
      'classes.book',
      'classes.attendance',
      'loyalty.read',
      'loyalty.manage',
      'referrals.read',
      'referrals.manage',
      'support.read',
      'support.manage',
      'feedback.read',
      'feedback.manage',
      'feedback.respond',
      'marketing.read',
      'marketing.manage',
      'accounting.read',
      'accounting.manage',
      'portal.manage',
      'kiosk.manage',
    ),
  },
  {
    key: 'HEAD_TRAINER',
    name: 'Head Trainer',
    description: 'Oversees the training team and all client programming.',
    permissions: perms(
      'members.read',
      'members.assign_trainer',
      'memberships.read',
      'attendance.read',
      'attendance.create',
      'workouts.read',
      'workouts.create',
      'workouts.assign',
      'nutrition.read',
      'nutrition.create',
      'nutrition.assign',
      'reports.view',
      'ai.generate',
      'ai.approve',
      'pt-sessions.read',
      'pt-sessions.create',
      'pt-sessions.update',
      'pt-packages.read',
      'pt-packages.create',
      'pt-packages.update',
      'appointments.read',
      'appointments.create',
      'appointments.update',
      'appointments.manage_availability',
    ),
  },
  {
    key: 'TRAINER',
    name: 'Trainer',
    description: 'Manages assigned clients: training, progress and attendance.',
    permissions: perms(
      'members.read_assigned',
      'memberships.read_assigned',
      'attendance.read_assigned',
      'attendance.create_assigned',
      'workouts.read_assigned',
      'workouts.create',
      'workouts.assign',
      'ai.generate',
      'pt-sessions.read_assigned',
      'pt-sessions.create',
      'pt-sessions.update',
      'pt-packages.read_assigned',
      'appointments.read_assigned',
      'appointments.create',
      'appointments.update',
      'classes.read',
      'classes.manage',
      'classes.book',
      'classes.attendance',
    ),
  },
  {
    key: 'NUTRITIONIST',
    name: 'Nutritionist',
    description: 'Manages nutrition and diet plans for assigned clients.',
    permissions: perms(
      'members.read',
      'nutrition.read',
      'nutrition.create',
      'nutrition.assign',
      'ai.generate',
    ),
  },
  {
    key: 'RECEPTIONIST',
    name: 'Receptionist',
    description: 'Front-desk operations: check-ins, basic member updates.',
    permissions: perms(
      'members.read',
      'members.create',
      'members.update',
      'memberships.read',
      'attendance.read',
      'attendance.create',
      'leads.read',
      'pt-sessions.read',
      'pt-sessions.create',
      'pt-packages.read',
      'pt-packages.create',
      'appointments.read',
      'appointments.create',
      'appointments.update',
      'classes.read',
      'classes.book',
    ),
  },
  {
    key: 'SALES_EXECUTIVE',
    name: 'Sales Executive',
    description: 'Manages leads, trials, and membership sales.',
    permissions: perms(
      'members.read',
      'members.create',
      'membership_plans.read',
      'memberships.read',
      'memberships.create',
      'leads.read',
      'leads.manage',
      'payments.read',
      'payments.create',
      'pt-packages.read',
      'pt-packages.create',
      'appointments.read',
      'appointments.create',
    ),
  },
  {
    key: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Manages payments, invoices, refunds and financial reporting.',
    permissions: perms(
      'members.read',
      'memberships.read',
      'payments.read',
      'payments.create',
      'payments.refund',
      'reports.view',
      'audit.read',
      'pt-packages.read',
      'expenses.read',
      'expenses.create',
      'expenses.update',
      'expenses.delete',
    ),
  },
  {
    key: 'INVENTORY_MANAGER',
    name: 'Inventory Manager',
    description: 'Manages products, stock, and suppliers.',
    permissions: perms('inventory.read', 'inventory.manage'),
  },
  {
    key: 'STAFF',
    name: 'Staff',
    description: 'General staff access with read-only visibility.',
    permissions: perms(
      'members.read',
      'memberships.read',
      'attendance.read',
      'attendance.create',
    ),
  },
  {
    key: 'MEMBER',
    name: 'Member',
    description: 'Gym member portal access to their own data.',
    /**
     * Deliberately empty, and that is the whole point (F-P0-1).
     *
     * This role used to carry `attendance.read`, `workouts.read` and
     * `nutrition.read` -- which are the *org-wide* read permissions.
     * `GET /attendance` accepts `attendance.read`, so a member holding
     * this role could have listed every check-in in the gym; the same
     * for everyone's workout and diet plans. Nothing ever issued the
     * role, which is the only reason it was not a live breach.
     *
     * The portal does not use RBAC permissions at all. Every `/portal`
     * route resolves the member from the caller's own JWT
     * (`Member.userId`) and scopes the query to them, so there is no
     * permission string a member could hold that widens the result --
     * "their own data" is enforced by the query, not by a grant.
     */
    permissions: perms(),
  },
];
