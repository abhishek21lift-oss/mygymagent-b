import { normaliseWhatsappNumber } from './whatsapp-web.sender';

describe('normaliseWhatsappNumber', () => {
  const india = { currency: 'INR', timezone: 'Asia/Kolkata' };
  const elsewhere = { currency: 'USD', timezone: 'America/New_York' };

  it("gives an Indian gym's local numbers +91", () => {
    expect(normaliseWhatsappNumber('98765 43210', india)).toBe('919876543210');
    expect(normaliseWhatsappNumber('098765-43210', india)).toBe('919876543210');
    expect(normaliseWhatsappNumber('+91 98765 43210', india)).toBe(
      '919876543210',
    );
    expect(normaliseWhatsappNumber('919876543210', india)).toBe('919876543210');
  });

  it('recognises India by timezone when the currency is unset', () => {
    expect(
      normaliseWhatsappNumber('9876543210', {
        currency: 'USD',
        timezone: 'Asia/Calcutta',
      }),
    ).toBe('919876543210');
  });

  it('keeps an explicit international number as it is, wherever the gym is', () => {
    expect(normaliseWhatsappNumber('+1 (415) 555-0100', india)).toBe(
      '14155550100',
    );
    expect(normaliseWhatsappNumber('0044 20 7946 0958', elsewhere)).toBe(
      '442079460958',
    );
  });

  it('refuses to guess a country code outside India', () => {
    // A wrong guess messages a stranger.
    expect(() => normaliseWhatsappNumber('4155550100', elsewhere)).toThrow(
      /country code/,
    );
  });

  it('refuses numbers too short or too long to be real', () => {
    expect(() => normaliseWhatsappNumber('12345', india)).toThrow();
    expect(() => normaliseWhatsappNumber('+1234567890123456', india)).toThrow();
  });
});
