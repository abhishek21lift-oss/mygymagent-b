/*
 * Membership Lifecycle OS: adds the PAUSED membership status (administrative
 * hold distinct from a plan freeze) and the MEMBERSHIP_EXPIRY_NOTICE
 * automation key used by the expiry scanner's notification step.
 *
 * Both changes are additive ALTER TYPE ... ADD VALUE statements on enums.
 * PostgreSQL 12+ supports adding enum values in a transaction as long as
 * the new value is not used in the same transaction.
 */

-- AlterEnum
ALTER TYPE "MembershipStatus" ADD VALUE 'PAUSED';

-- AlterEnum
ALTER TYPE "AutomationKey" ADD VALUE 'MEMBERSHIP_EXPIRY_NOTICE';
