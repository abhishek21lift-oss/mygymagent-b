import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/**
 * Logs business-critical operations for observability and debugging.
 * Unlike the AuditInterceptor which stores sanitized data for compliance,
 * this interceptor logs to application logs for developer/operator visibility.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startTime = Date.now();
    const request = context.switchToHttp().getRequest();

    // Extract useful context for logging
    const method = request.method;
    const path = request.url;
    const userId = request.user?.id ?? 'anonymous';
    const organizationId = request.user?.organizationId ?? null;
    const requestId = request.requestId ?? 'unknown';

    return next.handle().pipe(
      tap({
        next: (response) => {
          const duration = Date.now() - startTime;
          this.logger.log(
            `Request completed: ${method} ${path} - Status: ${response?.statusCode ?? 200} - ` +
              `User: ${userId} - Org: ${organizationId} - Duration: ${duration}ms - RequestID: ${requestId}`,
          );
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          this.logger.error(
            `Request failed: ${method} ${path} - ${error.message} - ` +
              `User: ${userId} - Org: ${organizationId} - Duration: ${duration}ms - RequestID: ${requestId}`,
            error.stack,
          );
        },
      }),
    );
  }
}
