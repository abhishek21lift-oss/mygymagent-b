// Jest setup file to disable throttling in tests
Object.defineProperty(global, 'TEST_MODE', {
  writable: true,
  configurable: true,
  value: true,
});
