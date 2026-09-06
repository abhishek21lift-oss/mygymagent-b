import { LoggingInterceptor } from './logging.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

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
});
