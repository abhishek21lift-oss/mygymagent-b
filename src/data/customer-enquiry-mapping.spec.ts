import {
  classifyRow,
  meaningful,
  mapGender,
  parseDayFirstDate,
  phoneKey,
  sourceNotes,
  splitName,
  toE164,
} from './customer-enquiry-mapping';

/**
 * These pin the five things the previous importer got wrong on the real
 * 1342-row export. Each `it` below, run against the old code, fails.
 */
describe('customer enquiry mapping', () => {
  describe('parseDayFirstDate', () => {
    it('reads DD-MM-YYYY as written', () => {
      expect(parseDayFirstDate('11-05-2026')?.toISOString().slice(0, 10)).toBe(
        '2026-05-11',
      );
      expect(parseDayFirstDate('26-12-2025')?.toISOString().slice(0, 10)).toBe(
        '2025-12-26',
      );
    });

    it('does not fall into the American reading', () => {
      // `new Date('11-05-2026')` is 5 November. This is the single
      // defect that silently moved 272 of 952 join dates.
      const parsed = parseDayFirstDate('11-05-2026')!;
      expect(parsed.getUTCMonth()).toBe(4); // May, not November
      expect(parsed.getUTCDate()).toBe(11);
    });

    it('accepts days past the 12th, which the old parser called invalid', () => {
      // 655 of 952 rows had a day > 12, so `new Date` returned Invalid
      // and the caller silently substituted the import timestamp.
      expect(parseDayFirstDate('26-09-2024')?.toISOString().slice(0, 10)).toBe(
        '2024-09-26',
      );
    });

    it('rejects a date that does not exist rather than rolling it over', () => {
      expect(parseDayFirstDate('31-02-2025')).toBeNull();
      expect(parseDayFirstDate('00-01-2025')).toBeNull();
      expect(parseDayFirstDate('01-13-2025')).toBeNull();
    });

    it('returns null for junk instead of guessing', () => {
      expect(parseDayFirstDate('')).toBeNull();
      expect(parseDayFirstDate('not a date')).toBeNull();
      expect(parseDayFirstDate(null)).toBeNull();
    });
  });

  describe('toE164', () => {
    it('keeps the country code the export supplies', () => {
      // Member.phone is handed to Meta as the WhatsApp `to:`, and Meta
      // needs the country code. The old mapping stored the bare local
      // number and put this column in a notes blob.
      expect(toE164('6393786886', '916393786886').phone).toBe('+916393786886');
    });

    it('falls back to the local number plus the country code', () => {
      expect(toE164('6393786886', null).phone).toBe('+916393786886');
    });

    it('reports a row where the two columns disagree instead of picking one silently', () => {
      const result = toE164('6393786886', '919999999999');
      expect(result.disagreement).toBe('6393786886 vs 919999999999');
    });

    it('gives up rather than inventing a number', () => {
      expect(toE164('12345', null).phone).toBeNull();
      expect(toE164(null, null).phone).toBeNull();
    });
  });

  it('matches phone numbers across formats', () => {
    // So a member stored as +91… is still recognised when the same
    // person is typed in locally, and a re-run does not duplicate them.
    expect(phoneKey('+916393786886')).toBe(phoneKey('6393786886'));
    expect(phoneKey('91 63937 86886')).toBe('6393786886');
    expect(phoneKey('123')).toBeNull();
  });

  describe('meaningful', () => {
    it('treats the export’s placeholders as empty', () => {
      // 33 rows say "None", 37 say "None" in Reference No, 1338 say
      // "UNKNOWN", 732 say "0". The old mapping stored all of them.
      for (const placeholder of ['None', 'NONE', 'UNKNOWN', '0', 'N/A', '-']) {
        expect(meaningful(placeholder)).toBeNull();
      }
    });

    it('keeps a real value', () => {
      expect(meaningful(' RENEWAL ')).toBe('RENEWAL');
      expect(meaningful('INSTAGRAM')).toBe('INSTAGRAM');
    });
  });

  it('leaves placeholders out of the notes entirely', () => {
    const notes = sourceNotes(
      {
        Notes: 'None',
        'Reference No': 'None',
        'Lead Type': '0',
        'Handled By': 'Abhishek Katiyar',
      },
      'YDL-1',
    );
    expect(notes).not.toContain('None');
    expect(notes).not.toContain('Lead Type');
    expect(notes).toContain('Handled By: Abhishek Katiyar');
    expect(notes).toContain('Source Code: YDL-1');
  });

  describe('splitName', () => {
    it('flags a single-word name rather than quietly doubling it', () => {
      // lastName is NOT NULL, so it still gets the first name -- but
      // 183 members would read "Amiy Amiy" and nobody was told.
      expect(splitName('Amiy')).toEqual({
        firstName: 'Amiy',
        lastName: 'Amiy',
        singleWord: true,
      });
    });

    it('splits a full name on the first space', () => {
      expect(splitName('Rishabh  GAutam ')).toEqual({
        firstName: 'Rishabh',
        lastName: 'GAutam',
        singleWord: false,
      });
    });
  });

  it('maps the gender spellings this export uses', () => {
    expect(mapGender('male')).toBe('MALE');
    expect(mapGender('Male')).toBe('MALE');
    expect(mapGender('female')).toBe('FEMALE');
    expect(mapGender('')).toBeNull();
  });

  describe('classifyRow', () => {
    it('treats a row with a membership status as a member', () => {
      expect(classifyRow({ 'Membership Status': 'Active' })).toBe('member');
      expect(classifyRow({ 'Membership Status': 'Inactive' })).toBe('member');
    });

    it('treats an unassigned row with no conversion as a lead', () => {
      expect(classifyRow({ 'Membership Status': 'Not assigned' })).toBe('lead');
    });

    it('calls an unassigned row that has converted ambiguous instead of dropping it', () => {
      // The old code filtered these out of both lists without a word.
      expect(
        classifyRow({
          'Membership Status': 'Not assigned',
          'Conversion Date': '26-09-2024',
        }),
      ).toBe('ambiguous');
    });
  });
});
