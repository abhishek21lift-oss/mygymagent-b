import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';
import {
  AUDITED_KEY,
  type AuditedOptions,
} from '../decorators/audited.decorator';

const SENSITIVE_KEYS = new Set(['passwordHash', 'password']);

/**
 * Produces a JSON-safe copy for the audit log's `Json` column. Deliberately
 * routed through JSON.stringify/parse rather than a hand-rolled object walk:
 * Prisma's Decimal (and Date) values carry a `.toJSON()`/`.toString()` that
 * JSON.stringify honors automatically, whereas a naive `Object.entries()`
 * walk picks up Decimal's internal own-enumerable `constructor` property
 * and produces a value Prisma's JSON serializer rejects.
 */
function sanitize(value: unknown): unknown {
  if (value === undefined) return null;
  const replacer = (key: string, val: unknown): unknown =>
    SENSITIVE_KEYS.has(key) ? undefined : val;
  return JSON.parse(JSON.stringify(value, replacer)) as unknown;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<
      AuditedOptions | undefined
    >(AUDITED_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    const branchIdHeader = request.headers['x-branch-id'];
    const branchId = Array.isArray(branchIdHeader)
      ? branchIdHeader[0]
      : branchIdHeader;
    const userAgentHeader = request.headers['user-agent'] as
      string | string[] | undefined;
    const userAgent = Array.isArray(userAgentHeader)
      ? userAgentHeader[0]
      : userAgentHeader;

    return next.handle().pipe(
      tap((response) => {
        void this.auditService.record({
          organizationId: user?.organizationId ?? null,
          branchId: branchId ?? null,
          actorUserId: user?.id ?? null,
          action: options.action,
          resource: options.resource,
          resourceId:
            (Array.isArray(request.params?.id)
              ? request.params.id[0]
              : request.params?.id) ??
            (response as { id?: string })?.id ??
            null,
          afterState: sanitize(response),
          ipAddress: request.ip,
          userAgent,
          requestId: request.requestId,
        });
      }),
    );
  }
}
