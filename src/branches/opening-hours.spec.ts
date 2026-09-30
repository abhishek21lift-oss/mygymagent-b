import { BadRequestException } from '@nestjs/common';
import {
  normaliseOpeningHours,
  readableTime,
  readableWeek,
} from './opening-hours';

const weekdays = [0, 1, 2, 3, 4, 5];

describe('readableWeek', () => {
  it('joins days with the same hours, and names closed days', () => {
    const slots = weekdays.flatMap((day) => [
      { day, open: '05:00', close: '11:00' },
      { day, open: '16:00', close: '22:00' },
    ]);
    expect(readableWeek(slots)).toEqual([
      'Mon–Sat: 5:00 am – 11:00 am, 4:00 pm – 10:00 pm',
      'Sun: Closed',
    ]);
  });

  it('keeps days apart when their hours differ', () => {
    expect(
      readableWeek([
        { day: 0, open: '06:00', close: '22:00' },
        { day: 1, open: '06:00', close: '22:00' },
        { day: 2, open: '07:00', close: '21:00' },
        { day: 6, open: '08:00', close: '12:00' },
      ]),
    ).toEqual([
      'Mon–Tue: 6:00 am – 10:00 pm',
      'Wed: 7:00 am – 9:00 pm',
      'Thu–Sat: Closed',
      'Sun: 8:00 am – 12:00 pm',
    ]);
  });

  it('is empty when no hours are set', () => {
    expect(readableWeek(null)).toEqual([]);
    expect(readableWeek([])).toEqual([]);
  });
});

describe('readableTime', () => {
  it.each([
    ['00:00', 'midnight'],
    ['24:00', 'midnight'],
    ['05:30', '5:30 am'],
    ['12:00', '12:00 pm'],
    ['22:05', '10:05 pm'],
  ])('%s -> %s', (time, text) => expect(readableTime(time)).toBe(text));
});

describe('normaliseOpeningHours', () => {
  it('sorts slots by day and time', () => {
    expect(
      normaliseOpeningHours([
        { day: 1, open: '16:00', close: '22:00' },
        { day: 0, open: '06:00', close: '10:00' },
        { day: 1, open: '05:00', close: '11:00' },
      ]),
    ).toEqual([
      { day: 0, open: '06:00', close: '10:00' },
      { day: 1, open: '05:00', close: '11:00' },
      { day: 1, open: '16:00', close: '22:00' },
    ]);
  });

  it('allows open until midnight', () => {
    expect(() =>
      normaliseOpeningHours([{ day: 0, open: '18:00', close: '24:00' }]),
    ).not.toThrow();
  });

  it('refuses a slot that closes before it opens', () => {
    expect(() =>
      normaliseOpeningHours([{ day: 2, open: '22:00', close: '06:00' }]),
    ).toThrow(
      new BadRequestException(
        'Wed: closing time 06:00 must be after opening time 22:00.',
      ),
    );
  });

  it('refuses overlapping slots on one day', () => {
    expect(() =>
      normaliseOpeningHours([
        { day: 3, open: '05:00', close: '12:00' },
        { day: 3, open: '11:00', close: '20:00' },
      ]),
    ).toThrow(/Thu: 05:00–12:00 and 11:00–20:00 overlap/);
  });
});
