import { IsOptional, IsUUID } from 'class-validator';

/**
 * `?branchId=` on a report: "show me just this branch".
 *
 * An explicit query parameter rather than the `x-branch-id` header,
 * because the web app sets that header to the user's own branch on
 * sign-in -- honouring it would quietly narrow an owner's whole-gym
 * reports to one branch. A filter is only ever a narrowing: see
 * `effectiveBranch`.
 */
export class BranchFilterQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/**
 * The branch a report is computed for.
 *
 * The enforced scope (`@CurrentBranchScope()`, derived from the caller's
 * grants) always wins: a branch-restricted manager asking for another
 * branch still gets their own. Only a caller who holds the permission
 * org-wide can narrow with `?branchId=`; anyone else's request for a
 * branch outside the organization simply matches nothing, because every
 * query is also scoped by organizationId.
 */
export function effectiveBranch(
  branchScope: string | null,
  requested: string | undefined,
): string | null {
  return branchScope ?? requested ?? null;
}
