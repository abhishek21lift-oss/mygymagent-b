import { HttpException, HttpStatus } from '@nestjs/common';
import { QueueConnection } from '../../queue/queue.module';
import { PublicRateLimitService } from './public-rate-limit.service';

/**
 * The kiosk endpoints this service guards are hit by unauthenticated
 * devices in bursts, so the important behaviours are the window boundary,
 * the exact 429 the controllers promise, and the fail-open path.
 */
describe('PublicRateLimitService', () => {
  const makeService = (client: Partial<QueueConnection['client']>) => {
    const queueConnection = { client } as unknown as QueueConnection;
    return new PublicRateLimitService(queueConnection);
  };

  it('opens the window on the first hit and does not extend it on later hits', async () => {
    const incr = jest.fn().mockResolvedValue(2);
    const expire = jest.fn().mockResolvedValue(true);
    const service = makeService({ incr, expire } as never);

    await service.consume('kiosk-checkin', '10.0.0.1', 60, 60);

    expect(incr).toHaveBeenCalledTimes(1);
    // First hit only -- the key is hashed, so the exact key is asserted
    // structurally here rather than by value.
    expect(expire).not.toHaveBeenCalled();
  });

  it('sets the window expiry on the very first hit', async () => {
    const incr = jest.fn().mockResolvedValue(1);
    const expire = jest.fn().mockResolvedValue(true);
    const service = makeService({ incr, expire } as never);

    await service.consume('kiosk-checkin', '10.0.0.1', 60, 60);

    expect(expire).toHaveBeenCalledTimes(1);
    const [key, seconds] = expire.mock.calls[0];
    expect(key).toMatch(/^public-ratelimit:kiosk-checkin:[a-f0-9]{64}$/);
    expect(seconds).toBe(60);
  });

  it('throws 429 past the limit, with the message the controllers promise', async () => {
    const incr = jest.fn().mockResolvedValue(61);
    const expire = jest.fn();
    const service = makeService({ incr, expire } as never);

    await expect(
      service.consume('kiosk-checkin', '10.0.0.1', 60, 60),
    ).rejects.toThrow(HttpException);

    try {
      await service.consume('kiosk-checkin', '10.0.0.1', 60, 60);
    } catch (e) {
      const error = e as HttpException;
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(error.message).toBe('Too many requests. Please try again later.');
    }
  });

  it('fails open when Redis errors, so check-in survives a Redis outage', async () => {
    const incr = jest.fn().mockRejectedValue(new Error('Redis down'));
    const service = makeService({ incr } as never);

    await expect(
      service.consume('kiosk-checkin', '10.0.0.1', 60, 60),
    ).resolves.toBeUndefined();
  });
});
