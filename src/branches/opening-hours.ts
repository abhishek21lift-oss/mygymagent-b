import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Matches, Max, Min } from 'class-validator';

/**
 * A branch's weekly opening hours: any number of slots per day, so a gym
 * open 5–11 am and again 4–10 pm is two slots. A day with no slot is
 * closed. Days run Monday (0) to Sunday (6).
 */
export interface OpeningSlot {
  day: number;
  open: string;
  close: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MAX_SLOTS = 28;

export class OpeningSlotDto implements OpeningSlot {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  day!: number;

  @Matches(TIME, { message: 'open must be a time like 06:00' })
  open!: string;

  @Matches(TIME, {
    message: 'close must be a time like 22:00 (24:00 for midnight)',
  })
  close!: string;
}

const minutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Sorted by day and time, and rejected if a slot ends before it starts or
 * two slots on one day overlap -- the checks a field decorator can't make.
 */
export function normaliseOpeningHours(slots: OpeningSlot[]): OpeningSlot[] {
  const sorted = [...slots]
    .map(({ day, open, close }) => ({ day, open, close }))
    .sort((a, b) => a.day - b.day || minutes(a.open) - minutes(b.open));
  for (const [i, slot] of sorted.entries()) {
    if (minutes(slot.close) <= minutes(slot.open)) {
      throw new BadRequestException(
        `${DAY_NAMES[slot.day]}: closing time ${slot.close} must be after opening time ${slot.open}.`,
      );
    }
    const previous = sorted[i - 1];
    if (
      previous &&
      previous.day === slot.day &&
      minutes(slot.open) < minutes(previous.close)
    ) {
      throw new BadRequestException(
        `${DAY_NAMES[slot.day]}: ${previous.open}–${previous.close} and ${slot.open}–${slot.close} overlap.`,
      );
    }
  }
  return sorted;
}

/** "06:00" → "6:00 am", "24:00" → "midnight". */
export function readableTime(time: string): string {
  if (time === '24:00' || time === '00:00') return 'midnight';
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * The week as a member reads it, consecutive days with the same hours
 * joined: ["Mon–Sat: 5:00 am – 11:00 am, 4:00 pm – 10:00 pm", "Sun:
 * Closed"]. Empty when no hours are set.
 */
export function readableWeek(
  slots: OpeningSlot[] | null | undefined,
): string[] {
  if (!slots || slots.length === 0) return [];
  const perDay = DAY_NAMES.map(
    (_, day) =>
      slots
        .filter((slot) => slot.day === day)
        .sort((a, b) => minutes(a.open) - minutes(b.open))
        .map(
          (slot) => `${readableTime(slot.open)} – ${readableTime(slot.close)}`,
        )
        .join(', ') || 'Closed',
  );
  const lines: string[] = [];
  let start = 0;
  for (let day = 1; day <= DAY_NAMES.length; day++) {
    if (day < DAY_NAMES.length && perDay[day] === perDay[start]) continue;
    const label =
      day - 1 === start
        ? DAY_NAMES[start]
        : `${DAY_NAMES[start]}–${DAY_NAMES[day - 1]}`;
    lines.push(`${label}: ${perDay[start]}`);
    start = day;
  }
  return lines;
}

/** Stored JSON back to slots, ignoring anything malformed. */
export function parseOpeningHours(value: unknown): OpeningSlot[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (slot): slot is OpeningSlot =>
      typeof slot === 'object' &&
      slot !== null &&
      Number.isInteger((slot as OpeningSlot).day) &&
      typeof (slot as OpeningSlot).open === 'string' &&
      typeof (slot as OpeningSlot).close === 'string',
  );
}
