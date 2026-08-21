import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Standardizes every error response into `{ error: { code, message,
 * details, requestId } }` and makes sure raw Prisma/driver errors never
 * leak internal details (table names, SQL, stack traces) to the client. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();

    const { status, body } = this.resolve(exception, request.requestId);

    if (status >= 500) {
      this.logger.error(
        `[${request.requestId}] ${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      // A no-op if SENTRY_DSN is unset (src/instrument.ts never called
      // Sentry.init) -- server logs remain the only record in that case,
      // same as before this was wired up.
      Sentry.captureException(exception, {
        tags: { requestId: request.requestId },
      });
    }

    response.status(status).json(body);
  }

  private resolve(
    exception: unknown,
    requestId?: string,
  ): { status: number; body: ApiErrorEnvelope } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            exception.message);
      return {
        status,
        body: {
          error: {
            code: HttpStatus[status] ?? 'ERROR',
            message: Array.isArray(message) ? message.join('; ') : message,
            details: typeof response === 'object' ? response : undefined,
            requestId,
          },
        },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            error: {
              code: 'CONFLICT',
              message: 'A record with the same unique value already exists.',
              requestId,
            },
          },
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: {
            error: {
              code: 'NOT_FOUND',
              message: 'Resource not found.',
              requestId,
            },
          },
        };
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }
}
