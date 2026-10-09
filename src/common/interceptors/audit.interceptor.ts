import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
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

/**
 * Response fields that are credentials, dropped at any depth before the
 * response becomes `afterState`. The audit log is readable by roles that
 * must never hold these (a manager reading an owner's TOTP seed defeats
 * the second factor), and it lands in every backup. An endpoint whose
 * credential sits under a generic name lists it in `@Audited({ redact })`.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'secret',
  'secretEnc',
  'otpauthUri',
  'recoveryCodes',
  'token',
  'tokenHash',
  'keyHash',
  'accessToken',
  'refreshToken',
  'qrDataUrl',
  'pairingCode',
]);

/**
 * Produces a JSON-safe copy for the audit log's `Json` column. Deliberately
 * routed through JSON.stringify/parse rather than a hand-rolled object walk:
 * Prisma's Decimal (and Date) values carry a `.toJSON()`/`.toString()` that
 * JSON.stringify honors automatically, whereas a naive `Object.entries()`
 * walk picks up Decimal's internal own-enumerable `constructor` property
 * and produces a value Prisma's JSON serializer rejects.
 */
export function sanitize(
  value: unknown,
  redact: readonly string[] = [],
): unknown {
  if (value === undefined) return null;
  const replacer = (key: string, val: unknown): unknown =>
    SENSITIVE_KEYS.has(key) || redact.includes(key) ? undefined : val;
  return JSON.parse(JSON.stringify(value, replacer)) as unknown;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

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
        this.auditService
          .record({
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
            afterState: sanitize(response, options.redact),
            ipAddress: request.ip,
            userAgent,
            requestId: request.requestId,
          })
          .catch((err: unknown) => {
            // Audit writes must never crash the request or become an
            // unhandled rejection (Node 22 crashes the process on those).
            this.logger.warn(
              `Audit record failed for ${options.action}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }),
    );
  }
}
