import { WEBHOOK_EVENTS, matches } from './webhook-events';

describe('WEBHOOK_EVENTS', () => {
  it('lists the five emittable events', () => {
    expect([...WEBHOOK_EVENTS]).toEqual([
      'message.received',
      'message.sent',
      'message.failed',
      'broadcast.finished',
      'connection.update',
    ]);
  });
});

describe('matches', () => {
  it('matches an exact event', () => {
    expect(matches(['message.received'], 'message.received')).toBe(true);
  });

  it('matches everything on wildcard', () => {
    expect(matches(['*'], 'broadcast.finished')).toBe(true);
  });

  it('rejects unlisted events', () => {
    expect(matches(['message.received'], 'message.sent')).toBe(false);
    expect(matches([], 'message.received')).toBe(false);
  });
});
