import { LoggingInterceptor } from './logging.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { HttpException } from '@nestjs/common';
import { HTTP_METRICS } from '../../command-center/collectors/http-metrics.ring';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let mockExecutionContext: ExecutionContext;
  let mockCallHandler: CallHandler;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();

    // Mock execution context
    mockExecutionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/test',
          user: { id: 'user-1', organizationId: 'org-1' },
          requestId: 'req-123',
          ip: '127.0.0.1',
        }),
      }),
    } as unknown as ExecutionContext;

    // Mock call handler
    mockCallHandler = {
      handle: jest.fn(),
    };
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should log successful requests', async () => {
    const mockResponse = { statusCode: 200, data: 'test' };
    (mockCallHandler.handle as jest.Mock).mockReturnValue(of(mockResponse));

    // Spy on logger
    const logSpy = jest.spyOn(interceptor['logger'], 'log');
    const errorSpy = jest.spyOn(interceptor['logger'], 'error');

    const result = interceptor.intercept(mockExecutionContext, mockCallHandler);

    // Subscribe to trigger the observable
    await result.toPromise();

    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockCallHandler.handle).toHaveBeenCalled();
  });

  it('should log failed requests', async () => {
    const mockError = new Error('Test error');
    (mockCallHandler.handle as jest.Mock).mockReturnValue(
      throwError(() => mockError),
    );

    // Spy on logger
    const logSpy = jest.spyOn(interceptor['logger'], 'log');
    const errorSpy = jest.spyOn(interceptor['logger'], 'error');

    const result = interceptor.intercept(mockExecutionContext, mockCallHandler);

    // Subscribe to trigger the observable
    await result.toPromise().catch(() => {}); // Expect error

    expect(errorSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(mockCallHandler.handle).toHaveBeenCalled();
  });

  it('records the real HTTP status into the latency ring, by route pattern', async () => {
    const before = HTTP_METRICS.summarize().status['2xx'];
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/members/8f2c1b7a-0000-4000-8000-000000000000',
          route: { path: '/members/:id' },
        }),
        getResponse: () => ({ statusCode: 201 }),
      }),
    } as unknown as ExecutionContext;
    (mockCallHandler.handle as jest.Mock).mockReturnValue(of({ id: 'x' }));
    await interceptor.intercept(context, mockCallHandler).toPromise();
    const after = HTTP_METRICS.summarize();
    expect(after.status['2xx']).toBe(before + 1);
    expect(after.slowestEndpoints.map((e) => e.path)).toContain('/members/:id');
  });

  it('records a thrown HttpException with its own status', async () => {
    const before = HTTP_METRICS.summarize().status['4xx'];
    (mockCallHandler.handle as jest.Mock).mockReturnValue(
      throwError(() => new HttpException('nope', 404)),
    );
    await interceptor
      .intercept(mockExecutionContext, mockCallHandler)
      .toPromise()
      .catch(() => undefined);
    expect(HTTP_METRICS.summarize().status['4xx']).toBe(before + 1);
  });
});
