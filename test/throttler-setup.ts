import { resetThrottlerStorageAsync } from './utils/test-app';

beforeEach(async () => {
  await resetThrottlerStorageAsync();
});
