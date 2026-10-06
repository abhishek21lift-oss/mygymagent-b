import type { ConfigService } from '@nestjs/config';
import { FreellmClient } from './freellm.client';

function clientWith(env: Record<string, string | undefined>) {
  return new FreellmClient({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('FreellmClient.usesLoopbackBaseUrl', () => {
  it('flags the localhost default a hosted deploy was never configured past', () => {
    expect(clientWith({}).usesLoopbackBaseUrl()).toBe(true);
    expect(
      clientWith({
        FREELLM_BASE_URL: 'http://localhost:3001/',
      }).usesLoopbackBaseUrl(),
    ).toBe(true);
  });

  it('accepts a real service URL', () => {
    expect(
      clientWith({
        FREELLM_BASE_URL: 'https://freellm.internal.example.com',
      }).usesLoopbackBaseUrl(),
    ).toBe(false);
  });
});
