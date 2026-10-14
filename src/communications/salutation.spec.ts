import { SALUTATIONS, applySalutation, isSalutation } from './salutation';

describe('salutation', () => {
  it('lists exactly the control-center options', () => {
    expect([...SALUTATIONS]).toEqual([
      'Dear',
      'Hello',
      'Respected',
      'Hi',
      'Hey',
      'Greetings',
    ]);
  });

  it('swaps a leading greeting without duplicating it', () => {
    expect(applySalutation('Hi Rahul, renew today', 'Dear')).toBe(
      'Dear Rahul, renew today',
    );
    expect(applySalutation('Hello {{1}}, welcome', 'Respected')).toBe(
      'Respected {{1}}, welcome',
    );
    expect(applySalutation('Hey {{1}}', 'Greetings')).toBe('Greetings {{1}}');
  });

  it('leaves bodies with no leading greeting alone', () => {
    expect(applySalutation('Happy birthday, Rahul!', 'Dear')).toBe(
      'Happy birthday, Rahul!',
    );
    expect(applySalutation('Invoice INV-1 is due.', 'Hi')).toBe(
      'Invoice INV-1 is due.',
    );
  });

  it('replaces rather than prepends when swapped twice', () => {
    const once = applySalutation('Hi Rahul', 'Dear');
    expect(applySalutation(once, 'Hey')).toBe('Hey Rahul');
  });

  it('ignores an unknown salutation', () => {
    expect(applySalutation('Hi Rahul', 'Yo')).toBe('Hi Rahul');
    expect(isSalutation('Yo')).toBe(false);
    expect(isSalutation('Dear')).toBe(true);
  });
});
