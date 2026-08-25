/**
 * Canonical `resource.action` permission catalog for the platform.
 *
 * This is data, not code branches: every permission listed here is a row
 * seeded into the `permissions` table (see prisma/seed.ts) and referenced
 * by key from route decorators (`@RequirePermissions('members.read')`).
 */
export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function resource(
  resource: string,
  actions: Record<string, string>,
): PermissionDefinition[] {
  return Object.entries(actions).map(([action, description]) => ({
    key: `${resource}.${action}`,
    resource,
    action,
    description,
  }));
}

export const PERMISSIONS_CATALOG: PermissionDefinition[] = [
  ...resource('organizations', {
    read: 'View organization profile and settings',
    update: 'Update organization profile and settings',
  }),
  ...resource('branches', {
    read: 'View branches',
    create: 'Create a branch',
    update: 'Update a branch',
    delete: 'Delete (deactivate) a branch',
  }),
  ...resource('users', {
    read: 'View staff/user accounts',
    create: 'Invite/create a staff user account',
    update: 'Update a staff user account',
    delete: 'Deactivate a staff user account',
    manage_roles: 'Assign or revoke roles for a user',
  }),
  ...resource('roles', {
    read: 'View roles and permissions',
    manage: 'Create/update custom roles and their permission grants',
  }),
  ...resource('audit', {
    read: 'View audit log entries',
  }),
  ...resource('settings', {
    manage: 'Manage organization-wide settings',
  }),
  ...resource('members', {
    read: 'View member profiles',
    read_assigned: 'View only members assigned to you (e.g. a trainer’s own clients)',
    create: 'Create a member',
    update: 'Update a member profile',
    delete: 'Delete (deactivate) a member',
    assign_trainer: 'Assign or change a member’s trainer',
  }),
  ...resource('membership_plans', {
    read: 'View membership plans',
    create: 'Create a membership plan',
    update: 'Update a membership plan',
    delete: 'Deactivate a membership plan',
  }),
  ...resource('memberships', {
    read: 'View member subscriptions',
    read_assigned: 'View subscriptions for members assigned to you',
    create: 'Sell/create a membership',
    update: 'Update a membership (freeze/extend/upgrade/cancel)',
  }),
  ...resource('attendance', {
    read: 'View attendance records',
    read_assigned: 'View attendance for members assigned to you',
    create: 'Record a check-in/check-out',
    create_assigned: 'Record attendance for members assigned to you',
  }),
  ...resource('payments', {
    read: 'View payments and invoices',
    create: 'Record a payment',
    refund: 'Issue a refund',
  }),
  ...resource('inventory', {
    read: 'View inventory',
    manage: 'Manage products, stock and suppliers',
  }),
  ...resource('leads', {
    read: 'View CRM leads',
    manage: 'Manage leads and follow-ups',
  }),
  ...resource('workouts', {
    read: 'View workout programs',
    create: 'Create a workout program/draft',
    assign: 'Assign a workout program to a member',
  }),
  ...resource('nutrition', {
    read: 'View nutrition/diet plans',
    create: 'Create a diet plan/draft',
    assign: 'Assign a diet plan to a member',
  }),
  ...resource('reports', {
    view: 'View analytics and business reports',
  }),
  ...resource('ai', {
    generate: 'Invoke AI generation features',
    approve: 'Approve AI-proposed changes before they are committed',
  }),
  ...resource('notifications', {
    manage: 'Manage notification templates and campaigns',
  }),
];

export const PERMISSION_KEYS = PERMISSIONS_CATALOG.map((p) => p.key);
