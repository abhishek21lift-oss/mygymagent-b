import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { HTTP_METRICS } from '../../command-center/collectors/http-metrics.ring';

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
    // The route pattern (`/members/:id`), not the concrete URL, so the
    // latency ring groups by endpoint rather than by member.
    const routePath: string = request.route?.path ?? path;

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          // The HTTP status lives on the response object; the value
          // emitted here is the handler's return body, which has none.
          const statusCode = responseStatus(context);
          HTTP_METRICS.record({
            durationMs: duration,
            statusCode,
            path: routePath,
            method,
          });
          this.logger.log(
            `Request completed: ${method} ${path} - Status: ${statusCode} - ` +
              `User: ${userId} - Org: ${organizationId} - Duration: ${duration}ms - RequestID: ${requestId}`,
          );
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          const statusCode: number =
            typeof error?.getStatus === 'function'
              ? error.getStatus()
              : (error?.status ?? 500);
          HTTP_METRICS.record({
            durationMs: duration,
            statusCode,
            path: routePath,
            method,
          });
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

/** The HTTP status Express will send, or 200 when there is no HTTP
 * response to read (a non-HTTP context). Telemetry must never be the
 * reason a request fails, so this cannot throw. */
function responseStatus(context: ExecutionContext): number {
  try {
    const response = context.switchToHttp().getResponse<{
      statusCode?: number;
    }>();
    return typeof response?.statusCode === 'number' ? response.statusCode : 200;
  } catch {
    return 200;
  }
}
