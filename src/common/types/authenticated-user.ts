export type PlatformRole = 'PLATFORM_OWNER' | 'PLATFORM_ADMIN';

/** Shape of `request.user`, populated exclusively by JwtStrategy.validate()
 * from the verified access token + a live DB lookup. Every downstream
 * service must derive organizationId/branchId scoping from this object --
 * never from client-supplied input. */
export interface AuthenticatedUser {
  id: string;
  organizationId: string | null;
  platformRole: PlatformRole | null;
  email: string;
  firstName: string;
  lastName: string;
  primaryBranchId: string | null;
}
