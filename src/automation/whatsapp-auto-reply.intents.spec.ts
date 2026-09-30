import { detectIntent, readableDuration } from './whatsapp-auto-reply.intents';

describe('detectIntent', () => {
  it.each([
    ['Membership', 'PLANS'],
    ['Memberships', 'PLANS'],
    ['what are the fees?', 'PLANS'],
    ['kitna paisa lagega', 'PLANS'],
    ['my membership', 'MY_PLAN'],
    ['mera plan kab tak hai', 'MY_PLAN'],
    ['RENEW', 'MY_PLAN'],
    ['class timings?', 'CLASSES'],
    ['Yoga schedule', 'CLASSES'],
    ['gym kahan hai', 'CONTACT'],
    ['address please', 'CONTACT'],
    ['Hi', 'MENU'],
    ['hello 👋', 'MENU'],
    ['Thanks!', 'THANKS'],
    ['ok', 'THANKS'],
    ['Can I bring a friend on Sunday?', 'UNKNOWN'],
    ['', 'UNKNOWN'],
    ['😀', 'UNKNOWN'],
  ])('%s -> %s', (text, intent) => {
    expect(detectIntent(text)).toBe(intent);
  });

  it('matches whole words only', () => {
    // "planning" is not "plan", "this" is not "hi".
    expect(detectIntent('this weekend planning')).toBe('UNKNOWN');
  });

  it('leaves long messages to a person', () => {
    expect(
      detectIntent(
        'hi I wanted to ask whether the membership includes the pool and steam room access too',
      ),
    ).toBe('UNKNOWN');
  });
});

describe('readableDuration', () => {
  it.each([
    [30, '1 month'],
    [90, '3 months'],
    [365, '1 year'],
    [730, '2 years'],
    [7, '1 week'],
    [14, '2 weeks'],
    [1, '1 day'],
    [45, '45 days'],
  ])('%i days -> %s', (days, text) => {
    expect(readableDuration(days)).toBe(text);
  });
});
