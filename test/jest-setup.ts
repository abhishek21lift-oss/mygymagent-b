// Jest setup file to disable throttling in tests
process.env.TEST_MODE = 'true';

Object.defineProperty(global, 'TEST_MODE', {
  writable: true,
  configurable: true,
  value: true,
});
