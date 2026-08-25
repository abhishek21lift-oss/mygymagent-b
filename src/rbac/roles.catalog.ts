import { PERMISSION_KEYS } from './permissions.catalog';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

const ALL_PERMISSIONS = PERMISSION_KEYS;

const perms = (...keys: string[]) => keys;

export const ROLES_CATALOG: RoleDefinition[] = [
  {
    key: 'PLATFORM_OWNER', name: 'Platform Owner',
    description: 'Full control over the platform across all organizations.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'PLATFORM_ADMIN', name: 'Platform Admin',
    description: 'Platform-level administration and support access.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'ORG_OWNER', name: 'Organization Owner',
    description: 'Full control over a single organization and all its branches.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'ORG_ADMIN', name: 'Organization Admin',
    description: 'Administers organization settings, staff, and all branches.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'BRANCH_MANAGER', name: 'Branch Manager',
    description: 'Manages day-to-day operations for one or more branches.',
    permissions: perms(
      'branches.read', 'users.read', 'members.read', 'members.create',
      'members.update', 'members.assign_trainer', 'membership_plans.read',
      'memberships.read', 'memberships.create', 'memberships.update',
      'attendance.read', 'attendance.create', 'payments.read', 'payments.create',
      'inventory.read', 'inventory.manage', 'leads.read', 'leads.manage',
      'reports.view', 'audit.read',
    ),
  },
  {
    key: 'HEAD_TRAINER', name: 'Head Trainer',
    description: 'Oversees the training team and all client programming.',
    permissions: perms(
      'members.read', 'members.assign_trainer', 'memberships.read',
      'attendance.read', 'attendance.create', 'workouts.read', 'workouts.create',
      'workouts.assign', 'nutrition.read', 'nutrition.create', 'nutrition.assign',
      'reports.view', 'ai.generate', 'ai.approve',
    ),
  },
  {
    key: 'TRAINER', name: 'Trainer',
    description: 'Manages assigned clients: training, progress and attendance.',
    permissions: perms(
      'members.read_assigned', 'memberships.read_assigned',
      'attendance.read_assigned', 'attendance.create_assigned',
      'workouts.read_assigned', 'workouts.create', 'workouts.assign', 'ai.generate',
    ),
  },
  {
    key: 'NUTRITIONIST', name: 'Nutritionist',
    description: 'Manages nutrition and diet plans for assigned clients.',
    permissions: perms(
      'members.read', 'nutrition.read', 'nutrition.create', 'nutrition.assign',
      'ai.generate',
    ),
  },
  {
    key: 'RECEPTIONIST', name: 'Receptionist',
    description: 'Front-desk operations: check-ins, basic member updates.',
    permissions: perms(
      'members.read', 'members.create', 'members.update', 'memberships.read',
      'attendance.read', 'attendance.create', 'leads.read',
    ),
  },
  {
    key: 'SALES_EXECUTIVE', name: 'Sales Executive',
    description: 'Manages leads, trials, and membership sales.',
    permissions: perms(
      'members.read', 'members.create', 'membership_plans.read', 'memberships.read',
      'memberships.create', 'leads.read', 'leads.manage', 'payments.read',
      'payments.create',
    ),
  },
  {
    key: 'ACCOUNTANT', name: 'Accountant',
    description: 'Manages payments, invoices, refunds and financial reporting.',
    permissions: perms(
      'members.read', 'memberships.read', 'payments.read', 'payments.create',
      'payments.refund', 'reports.view', 'audit.read',
    ),
  },
  {
    key: 'INVENTORY_MANAGER', name: 'Inventory Manager',
    description: 'Manages products, stock, and suppliers.',
    permissions: perms('inventory.read', 'inventory.manage'),
  },
  {
    key: 'STAFF', name: 'Staff',
    description: 'General staff access with read-only visibility.',
    permissions: perms('members.read', 'memberships.read', 'attendance.read', 'attendance.create'),
  },
  {
    key: 'MEMBER', name: 'Member',
    description: 'Gym member portal access to their own data.',
    permissions: perms('attendance.read', 'workouts.read', 'nutrition.read'),
  },
];
