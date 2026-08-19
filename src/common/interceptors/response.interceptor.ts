import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';

export interface ApiSuccessEnvelope<T> {
  data: T;
  meta: {
    requestId: string;
  };
}

/** Wraps every successful response in a consistent `{ data, meta }`
 * envelope so the frontend's typed API client never has to guess the
 * response shape per-endpoint. Errors are shaped by AllExceptionsFilter. */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessEnvelope<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessEnvelope<T>> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      map((data) => ({
        data,
        meta: { requestId: request.requestId },
      })),
    );
  }
}
