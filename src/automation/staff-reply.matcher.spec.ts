import {
  matchRule,
  parseBotCommand,
  type StaffRule,
} from './staff-reply.matcher';

const rules: StaffRule[] = [
  {
    id: 'r1',
    keyword: 'fees',
    matchType: 'CONTAINS',
    scope: 'ALL',
    answer: 'Fees info',
    enabled: true,
    priority: 0,
  },
  {
    id: 'r2',
    keyword: 'fees',
    matchType: 'EXACT',
    scope: 'ALL',
    answer: 'Exact fees',
    enabled: true,
    priority: 0,
  },
  {
    id: 'r3',
    keyword: 'group-only',
    matchType: 'EXACT',
    scope: 'GROUP',
    answer: 'G',
    enabled: true,
    priority: 0,
  },
  {
    id: 'r4',
    keyword: 'off',
    matchType: 'EXACT',
    scope: 'ALL',
    answer: 'X',
    enabled: false,
    priority: 0,
  },
  {
    id: 'r5',
    keyword: 'fee(s|收取',
    matchType: 'REGEX',
    scope: 'ALL',
    answer: 'Bad',
    enabled: true,
    priority: 0,
  },
  {
    id: 'r6',
    keyword: '^slot \\d+$',
    matchType: 'REGEX',
    scope: 'ALL',
    answer: 'Slot',
    enabled: true,
    priority: 10,
  },
];

describe('matchRule', () => {
  it('prefers EXACT over CONTAINS', () => {
    expect(matchRule(rules, 'fees', false)?.id).toBe('r2');
  });

  it('ignores GROUP-scope rules in 1:1 chats', () => {
    expect(matchRule(rules, 'group-only', false)).toBeNull();
    expect(matchRule(rules, 'group-only', true)?.id).toBe('r3');
  });

  it('skips disabled rules', () => {
    expect(matchRule(rules, 'off', false)).toBeNull();
  });

  it('skips invalid regex without throwing', () => {
    expect(() => matchRule(rules, 'fee(s', false)).not.toThrow();
    expect(matchRule(rules, 'slot 5', false)?.id).toBe('r6');
  });
});

describe('parseBotCommand', () => {
  it('parses #help case-insensitively on the first token', () => {
    expect(parseBotCommand('#HELP me')).toBe('help');
    expect(parseBotCommand('#stop')).toBe('stop');
    expect(parseBotCommand('#start now')).toBe('start');
  });

  it('ignores non-commands', () => {
    expect(parseBotCommand('hello #help')).toBeNull();
    expect(parseBotCommand('  ')).toBeNull();
  });
});
