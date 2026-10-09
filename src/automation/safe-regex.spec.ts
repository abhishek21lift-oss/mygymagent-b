import { boundedTest, unsafeRegexReason } from './safe-regex';

describe('boundedTest', () => {
  it('matches like RegExp.test', () => {
    expect(boundedTest(/slot \d+/i, 'Slot 5 please')).toBe(true);
    expect(boundedTest(/slot \d+/i, 'no')).toBe(false);
  });

  it('returns null when the pattern runs out of time', () => {
    const started = Date.now();
    expect(boundedTest(/(a+)+$/, 'a'.repeat(40) + '!')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('unsafeRegexReason', () => {
  it.each([
    '^(hi|hello)\\b',
    'fees?',
    'timing|time',
    'slot \\d{1,2}',
    '\\bpt\\b',
  ])('accepts %s', (pattern) => {
    expect(unsafeRegexReason(pattern)).toBeNull();
  });

  it.each(['(a+)+$', '(\\w*\\s?)*$', '(x{1,3})+y', '([a-z]+)*!'])(
    'rejects nested repeats like %s',
    (pattern) => {
      expect(unsafeRegexReason(pattern)).toMatch(/repeats/);
    },
  );

  it('rejects a pattern that backtracks without a nested repeat', () => {
    expect(unsafeRegexReason('^(a|a)*$')).toMatch(/too long/);
  });

  it('rejects an invalid pattern', () => {
    expect(unsafeRegexReason('fee(s')).toMatch(/not a valid/);
  });
});
