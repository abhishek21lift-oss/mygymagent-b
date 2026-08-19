import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'audited';

export interface AuditedOptions {
  resource: string;
  action: string;
}

/** Marks a mutating handler for automatic audit logging by AuditInterceptor.
 * Captures actor, org/branch, the route's `id` param as resourceId, and the
 * response body as afterState. For changes where recording a beforeState
 * matters (e.g. role/permission changes), call AuditService directly from
 * the service method instead of relying on this decorator alone. */
export const Audited = (options: AuditedOptions) =>
  SetMetadata(AUDITED_KEY, options);
