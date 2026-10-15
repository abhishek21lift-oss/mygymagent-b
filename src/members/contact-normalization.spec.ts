import {
  normalizeEmail,
  normalizeMemberContact,
  normalizePhoneDigits,
  phoneLookupKey,
} from './contact-normalization';

/** D-DB02: identity normalization matrix (pure functions, no database). */
describe('contact normalization', () => {
  it('lowercases and trims emails; blanks become null', () => {
    expect(normalizeEmail('Rahul@Gym.COM')).toBe('rahul@gym.com');
    expect(normalizeEmail('  a@b.co  ')).toBe('a@b.co');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('strips phones to digits; blanks become null', () => {
    expect(normalizePhoneDigits('+91 98765 43210')).toBe('919876543210');
    expect(normalizePhoneDigits('(080) 4112-3456')).toBe('08041123456');
    expect(normalizePhoneDigits('')).toBeNull();
    expect(normalizePhoneDigits('  --  ')).toBeNull();
    expect(normalizePhoneDigits(null)).toBeNull();
  });

  it('derives the last-10-digit lookup key; short numbers give null', () => {
    expect(phoneLookupKey('+919876543210')).toBe('9876543210');
    expect(phoneLookupKey('9876543210')).toBe('9876543210');
    expect(phoneLookupKey('12345')).toBeNull();
    expect(phoneLookupKey(null)).toBeNull();
  });

  it('normalizes email but preserves phone formatting for storage', () => {
    const dto: any = {
      email: 'A@B.CO',
      phone: '+91 98765 43210',
      alternatePhone: '',
      firstName: 'Asha',
    };
    normalizeMemberContact(dto);
    expect(dto).toEqual({
      email: 'a@b.co',
      phone: '+91 98765 43210',
      alternatePhone: undefined,
      firstName: 'Asha',
    });
  });

  it('leaves absent fields absent (PATCH untouched semantics)', () => {
    const dto: any = { firstName: 'Asha' };
    normalizeMemberContact(dto);
    expect(dto).toEqual({ firstName: 'Asha' });
    expect('email' in dto).toBe(false);
  });

  it('preserves explicit null (field-clear semantic)', () => {
    const dto: any = { email: null, phone: null, firstName: 'Asha' };
    normalizeMemberContact(dto);
    expect(dto).toEqual({ email: null, phone: null, firstName: 'Asha' });
  });
});
